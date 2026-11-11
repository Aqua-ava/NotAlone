import {observedProcessingAction} from './diagnostics.ts';
import {boundContentInputs} from './content.ts';
import {candidateAdmission,type CandidateVerificationReference} from './management/admission.ts';
import {finalizeOwnerContributions} from './owner-contribution.ts';
import {randomUUID} from 'node:crypto';
import {sha256} from '../../platform/sha256.ts';
import type {StorageAction,StorageTransaction,StorageRow,StorageLease} from '../../storage/sqlite/contracts.ts';
import {validateModelLedgerReceipt,type ModelLedgerReceipt} from '../../platform/models/model-ledger-contract.ts';
import type {ModelTaskClaim} from '../../platform/models/model-permit-port.ts';
import {assertContribution,assertInputs,currentAttempt,inputRows,fail,textId} from './qualification.ts';
import {applyControl,takeOverExpiredAttempt} from './control.ts';
import {abandonUnknownAdjudication} from './unknown-recovery.ts';
import {hasRunFollowupState,snapshot} from './runs.ts';
import {retireStalePausedRuns} from './run-retirement.ts';
import {isolatedInputs,recordImageIsolation,retryIsolatedImages} from './image-isolation.ts';
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:unknown,lease:StorageLease)=>unknown):StorageAction=>observedProcessingAction({name:`memoryExtraction.${name}`,mode,retryBusy:mode==='write',execute} as StorageAction);
const budgetNumbers=['input_tokens','max_output_tokens','context_window_tokens','safety_margin_tokens','serialized_bytes'] as const;
function budgetSummary(value:unknown):Record<string,number>|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const budget=value as Record<string,unknown>;
 if(budgetNumbers.some(key=>!Number.isSafeInteger(budget[key])||Number(budget[key])<1))return null;
 return Object.fromEntries(budgetNumbers.map(key=>[key,Number(budget[key])]));
}
/** 删除正文后保留核对与结算所需数值，不保留输入摘要或请求指纹。 */
export function minimalModelReceipt(raw:unknown):string|null {
 if(raw===null)return null;
 let value:Record<string,unknown>;try{value=typeof raw==='string'?JSON.parse(raw):raw as Record<string,unknown>;}catch{return null;}
 const fields=['attempt_id','permit_id','request_id','owner_id','contact_id','scope_kind','provider','model','called_at','latency_ms','dispatch','outcome'];
 const result:Record<string,unknown>=Object.fromEntries(fields.filter(k=>value[k]===null||typeof value[k]==='string'||typeof value[k]==='number').map(k=>[k,value[k]]));
 const budget=budgetSummary(value.input_budget??value.input_budget_summary);if(budget)result.input_budget_summary=budget;
 for(const [key,allowed] of [['usage',['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens']],['cost',['status','amount','currency','pricing_version']]] as const){
  const source=value[key];if(source&&typeof source==='object'&&!Array.isArray(source)){const record=source as Record<string,unknown>;result[key]=Object.fromEntries(allowed.filter(k=>record[k]===null||typeof record[k]==='string'||typeof record[k]==='number').map(k=>[k,record[k]]));}
 }
 return JSON.stringify(result);
}
function event(tx:StorageTransaction,i:{ownerId:string;attemptId:string;kind:string;payload:unknown;inputNos?:number[];callId?:string;reuseId?:string},lease:StorageLease):string {
 const {attempt,rows}=currentAttempt(tx,i.ownerId,i.attemptId,lease);
 const selected=i.inputNos===undefined?rows:i.inputNos.map(no=>rows.find(r=>Number(r.input_no)===no)??fail('memory_extraction_input_not_frozen'));
 if(i.inputNos&&selected.length!==new Set(i.inputNos).size)fail('memory_extraction_input_not_frozen');
 const eventId=randomUUID();const no=tx.get('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[i.ownerId,i.attemptId])!.n;
 tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,reused_call_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[i.ownerId,eventId,i.attemptId,no,i.kind,i.callId??null,i.reuseId??null,JSON.stringify(i.payload),Date.now()]);
 for(const [index,row] of selected.entries()){
  tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,?,?,?,?)',[i.ownerId,eventId,index+1,row.role,index+1,attempt.step_id,row.planned_input_no]);
  tx.run('INSERT OR IGNORE INTO event_source VALUES(?,?,?,?)',[i.ownerId,eventId,row.source_contact_id,row.record_id]);
 }
 return eventId;
}
function assertEffectAvailable(tx:StorageTransaction,ownerId:string,itemId:unknown,purpose:string,operationId:string):void {
 const occupied=tx.get(`SELECT o.state FROM operation_item i JOIN model_operation o ON o.owner_id=i.owner_id AND o.id=i.operation_id
 WHERE i.owner_id=? AND i.item_id=? AND i.effect_kind=? AND i.operation_id<>? AND i.state IN ('reserved','sent','unknown')`,[ownerId,itemId as string,purpose,operationId]);
 if(occupied)fail(occupied.state==='unknown'||occupied.state==='sealed'?'memory_extraction_receipt_unknown':'memory_extraction_target_in_progress');
}
function occupy(tx:StorageTransaction,ownerId:string,rows:StorageRow[],operationId:string,purpose:string,state:'reserved'|'sent'):void {
 for(const item of rows.filter(r=>r.role==='target'))assertEffectAvailable(tx,ownerId,item.item_id,purpose,operationId);
 for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state=? WHERE owner_id=? AND operation_id=?`,[state,ownerId,operationId]);
}
function reconcile(tx:StorageTransaction,ownerId:string,runId:string){
 for(const c of tx.all("SELECT * FROM run_contact WHERE owner_id=? AND run_id=? AND state='active'",[ownerId,runId])){
  try{assertContribution(tx,ownerId,runId,String(c.contact_id));}catch{
   tx.run("UPDATE run_contact SET state='revoked' WHERE owner_id=? AND run_id=? AND contact_id=?",[ownerId,runId,c.contact_id]);
   tx.run("UPDATE processing_task SET state='revoked',control_revision=control_revision+1,error_code='memory_extraction_scope_stale' WHERE owner_id=? AND run_id=? AND id IN (SELECT task_id FROM task_contribution WHERE owner_id=? AND run_id=? AND source_contact_id=?) AND state<>'revoked'",[ownerId,runId,ownerId,runId,c.contact_id]);
  }
 }
}
function prepareStep(tx:StorageTransaction,i:{ownerId:string;runId:string;taskId:string},lease:StorageLease){
 reconcile(tx,i.ownerId,i.runId);
 const r=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[i.ownerId,i.runId]);
 if(!r||r.pause_requested_at!==null||['paused','revoked'].includes(String(r.state)))return null;
 const t=tx.get("SELECT * FROM processing_task WHERE owner_id=? AND id=? AND run_id=? AND scope_kind='contact'",[i.ownerId,i.taskId,i.runId]);
 if(!t||['revoked','unknown','succeeded','awaiting_decision'].includes(String(t.state)))return null;
 // 过期租约在领取时保守接替：先按“未发出/已发出未知”收尾旧attempt，再允许新attempt。
 if(!takeOverExpiredAttempt(tx,i.ownerId,i.taskId))return null;
 let s=tx.get("SELECT * FROM processing_step WHERE owner_id=? AND task_id=? AND state IN ('failed','pending') ORDER BY step_no LIMIT 1",[i.ownerId,i.taskId]);
 while(s){
  const completed=inputRows(tx,i.ownerId,String(s.id)).filter(row=>row.role==='target').some(row=>tx.get("SELECT 1 FROM processing_item WHERE owner_id=? AND id=? AND extraction_state='succeeded'",[i.ownerId,row.item_id]));
  if(!completed)break;
  // 新轮完成不能改写旧轮失败事实；只为仍未成功的原固定目标建立后续步骤。
  tx.run("UPDATE processing_step SET state='revoked',successful_attempt_id=NULL WHERE owner_id=? AND id=?",[i.ownerId,s.id]);
  tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=coalesce(commit_forbidden_at,?) WHERE owner_id=? AND memory_step_id=?",[Date.now(),i.ownerId,s.id]);
  s=tx.get("SELECT * FROM processing_step WHERE owner_id=? AND task_id=? AND state IN ('failed','pending') ORDER BY step_no LIMIT 1",[i.ownerId,i.taskId]);
 }
 if(!s){
  let rows=tx.all(`SELECT i.* FROM run_input i JOIN processing_item p ON p.owner_id=i.owner_id AND p.id=i.item_id
   WHERE i.owner_id=? AND i.run_id=? AND i.source_contact_id=? AND i.role='target' AND p.extraction_state<>'succeeded'
   AND NOT EXISTS(SELECT 1 FROM step_input si JOIN processing_step ps ON ps.owner_id=si.owner_id AND ps.id=si.step_id WHERE si.owner_id=i.owner_id AND si.run_id=i.run_id AND si.run_input_no=i.input_no AND ps.task_id=? AND ps.state<>'revoked') ORDER BY i.input_no LIMIT 20`,[i.ownerId,i.runId,t.contact_id,i.taskId]);
  if(!rows.length){
   const reuseGuard=tx.get('SELECT 1 FROM schema_migration WHERE version=13')?`AND NOT EXISTS(SELECT 1 FROM document_extraction_reuse reuse JOIN step_attempt a ON a.owner_id=reuse.owner_id AND a.id=reuse.source_attempt_id AND a.state='succeeded' JOIN processing_step original ON original.owner_id=a.owner_id AND original.id=a.step_id AND original.state='succeeded' AND original.successful_attempt_id=a.id WHERE reuse.owner_id=i.owner_id AND reuse.run_id=i.run_id AND reuse.input_no=i.input_no)`:'';
   const elsewhere=!!tx.get(`SELECT 1 FROM run_input i WHERE i.owner_id=? AND i.run_id=? AND i.source_contact_id=? AND i.role='target'
    ${reuseGuard}
    AND NOT EXISTS(SELECT 1 FROM step_input si JOIN processing_step ps ON ps.owner_id=si.owner_id AND ps.id=si.step_id WHERE si.owner_id=i.owner_id AND si.run_id=i.run_id AND si.run_input_no=i.input_no AND ps.task_id=? AND ps.state='succeeded')`,[i.ownerId,i.runId,t.contact_id,i.taskId]);
   tx.run('UPDATE processing_task SET state=?,error_code=? WHERE owner_id=? AND id=?',[elsewhere?'incomplete':'succeeded',elsewhere?'targets_completed_elsewhere':null,i.ownerId,i.taskId]);return null;
  }
  let context=tx.all("SELECT * FROM run_input WHERE owner_id=? AND run_id=? AND source_contact_id=? AND role='context' ORDER BY input_no LIMIT 8",[i.ownerId,i.runId,t.contact_id]);
  ({targets:rows,context}=boundContentInputs(tx,i.ownerId,rows,context));
  const id=randomUUID();const n=tx.get('SELECT coalesce(max(step_no),0)+1 AS n FROM processing_step WHERE owner_id=? AND task_id=?',[i.ownerId,i.taskId])!.n;
  tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,successful_attempt_id) VALUES(?,?,?,?,'extraction_verification','pending','frozen',NULL)",[i.ownerId,id,i.taskId,n]);
  for(const [index,row] of [...context,...rows].entries())tx.run('INSERT INTO step_input(owner_id,step_id,input_no,run_id,run_input_no) VALUES(?,?,?,?,?)',[i.ownerId,id,index+1,i.runId,row.input_no]);
  s=tx.get('SELECT * FROM processing_step WHERE owner_id=? AND id=?',[i.ownerId,id])!;
 }
 const rows=inputRows(tx,i.ownerId,String(s.id));assertInputs(tx,i.ownerId,i.runId,rows);
 const attemptId=randomUUID(),token=randomUUID();const n=tx.get('SELECT coalesce(max(attempt_no),0)+1 AS n FROM step_attempt WHERE owner_id=? AND step_id=?',[i.ownerId,s.id])!.n;
 tx.run("INSERT INTO step_attempt VALUES(?,?,?,?,?,?,?,?,?,'running',?,NULL,NULL)",[i.ownerId,attemptId,s.id,n,t.resume_no,token,Date.now()+30*60_000,t.control_revision,lease.runtimeId,Date.now()]);
 tx.run("UPDATE processing_step SET state='running' WHERE owner_id=? AND id=?",[i.ownerId,s.id]);tx.run("UPDATE processing_task SET state='running',error_code=NULL WHERE owner_id=? AND id=?",[i.ownerId,t.id]);tx.run("UPDATE processing_run SET state='running' WHERE owner_id=? AND id=?",[i.ownerId,i.runId]);
 return {attemptId,stepId:String(s.id),taskId:i.taskId,runId:i.runId,contactId:String(t.contact_id),rows,policyConfig:JSON.parse(String(r.policy_config)),claim:{task_id:i.taskId,step_id:String(s.id),step_name:'extraction_verification',worker_id:lease.runtimeId,lease_generation:Number(t.resume_no)}};
}
export const executionActions:StorageAction[]=[
 action('blockClaim','write',(tx,raw)=>{
  const i=raw as {ownerId:string;runId:string;taskId:string;code:string};
  const code=/^(history_|memory_extraction_|storage_)[a-z_]+$/.test(i.code)?i.code:'memory_extraction_claim_failed';
  // 领取事务已回滚，不能伪造attempt或覆盖在途／未知调用；只记录没有执行者的失败。
  tx.run(`UPDATE processing_task SET state='failed',error_code=? WHERE owner_id=? AND run_id=? AND id=? AND state IN ('pending','running')
   AND NOT EXISTS(SELECT 1 FROM processing_step s WHERE s.owner_id=processing_task.owner_id AND s.task_id=processing_task.id AND s.state IN ('running','unknown'))`,[code,i.ownerId,i.runId,i.taskId]);
  return null;
 }),
 action('claim','write',(tx,raw,lease)=>prepareStep(tx,raw as Parameters<typeof prepareStep>[1],lease)),
 action('current','read',(tx,raw,lease)=>{const i=raw as {ownerId:string;attemptId:string};currentAttempt(tx,i.ownerId,i.attemptId,lease);return true;}),
 action('isolateImage','write',(tx,raw,lease)=>recordImageIsolation(tx,raw as Parameters<typeof recordImageIsolation>[1],lease)),
 action('retryImages','write',(tx,raw)=>{const result=retryIsolatedImages(tx,raw as Parameters<typeof retryIsolatedImages>[1]);return snapshot(tx,result.ownerId,result.runId);}),
 action('imageRecoveryPlan','read',(tx,raw,lease)=>{
  const i=raw as {ownerId:string;attemptId:string};const {attempt}=currentAttempt(tx,i.ownerId,i.attemptId,lease);
  return tx.all(`SELECT e.payload FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
   WHERE e.owner_id=? AND a.step_id=? AND e.kind='image_input_degraded'`,[i.ownerId,attempt.step_id])
   .map(row=>Number(JSON.parse(String(row.payload)).slot)).filter(slot=>Number.isSafeInteger(slot)&&slot>=0&&slot<=128);
 }),
 /** 原窗的已知终态只供审计；新子窗使用不同slot与请求，未知调用绝不释放。 */
 action('supersedeImageInput','write',(tx,raw,lease)=>{
  const i=raw as {ownerId:string;attemptId:string;slot:number;inputNos:number[];unchangedVariant?:boolean};const {attempt}=currentAttempt(tx,i.ownerId,i.attemptId,lease);
  if(!Number.isSafeInteger(i.slot)||i.slot<0||i.slot>128)fail('memory_extraction_input_invalid');
  const calls=tx.all(`SELECT c.*,o.id AS op_id FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
   WHERE c.owner_id=? AND o.memory_step_id=? AND o.slot=? AND o.purpose IN ('extraction','verification')`,[i.ownerId,attempt.step_id,i.slot]);
  if(!calls.length&&i.unchangedVariant===true){
   event(tx,{ownerId:i.ownerId,attemptId:i.attemptId,kind:'image_input_degraded',payload:{slot:i.slot,reason:'extraction_model_image_variant_unchanged'},inputNos:i.inputNos},lease);return true;
  }
  if(!calls.length||calls.some(call=>['sending','unknown'].includes(String(call.state))))fail('memory_extraction_receipt_unknown');
  for(const call of calls){
   if(call.state==='prepared'){
    if(call.receipt!==null||call.sent_at!==null)fail('memory_extraction_receipt_unknown');
    tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND id=?",[i.ownerId,call.id]);
   }else if(call.state==='failed'){
    const receipt=call.receipt===null?null:JSON.parse(String(call.receipt));
    if(call.settlement_state!=='settled'||call.error_code!=='not_dispatched'&&receipt?.dispatch!=='not_sent'&&receipt?.terminal_failure!=='transport')fail('memory_extraction_receipt_unknown');
   }else if(call.state!=='succeeded'||call.settlement_state!=='settled')fail('memory_extraction_receipt_unknown');
   event(tx,{ownerId:i.ownerId,attemptId:i.attemptId,kind:'image_input_degraded',callId:String(call.id),payload:{slot:i.slot,reason:'media_model_input_unavailable'},inputNos:i.inputNos},lease);
   tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=coalesce(commit_forbidden_at,?) WHERE owner_id=? AND id=?",[Date.now(),i.ownerId,call.op_id]);
   for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id=?`,[i.ownerId,call.op_id]);
  }
  return true;
 }),
 action('event','write',(tx,raw,lease)=>event(tx,raw as Parameters<typeof event>[1],lease)),
 action('prepareCall','write',(tx,raw,lease)=>{
  const i=raw as {ownerId:string;attemptId:string;purpose:string;request:unknown;provider:string;model:string;configurationId:string;inputCap:number;outputCap:number;inputNos:number[];slot?:number};
  const {attempt,task,rows}=currentAttempt(tx,i.ownerId,i.attemptId,lease);
  const slot=i.slot??0;if(!Number.isSafeInteger(slot)||slot<0||slot>128)fail('memory_extraction_input_invalid');
  const selected=i.inputNos.map(no=>rows.find(row=>Number(row.input_no)===no)??fail('memory_extraction_input_not_frozen'));
  if(!['extraction','verification'].includes(i.purpose)||!Number.isSafeInteger(i.inputCap)||i.inputCap<1||!Number.isSafeInteger(i.outputCap)||i.outputCap<1)fail('memory_extraction_model_configuration_invalid');
  if(rows.some(row=>row.role==='target'&&tx.get("SELECT 1 FROM processing_item WHERE owner_id=? AND id=? AND extraction_state='succeeded'",[i.ownerId,row.item_id])))fail('memory_extraction_targets_completed_elsewhere');
  const seal=sha256(JSON.stringify(i.request));
  let operation=tx.get('SELECT * FROM model_operation WHERE owner_id=? AND memory_step_id=? AND purpose=? AND slot=?',[i.ownerId,attempt.step_id,i.purpose,slot]);
  if(operation){
   if(operation.input_seal!==seal||operation.commit_forbidden_at!==null)fail('memory_extraction_operation_changed');
   const known=tx.get("SELECT c.*,e.payload FROM model_call c JOIN execution_event e ON e.owner_id=c.owner_id AND e.originated_call_id=c.id AND e.kind='model_output' WHERE c.owner_id=? AND c.operation_id=? AND c.state='succeeded' ORDER BY c.attempt_no DESC LIMIT 1",[i.ownerId,operation.id]);
   if(known&&operation.state!=='failed'){occupy(tx,i.ownerId,selected,String(operation.id),i.purpose,'sent');return {callId:String(known.id),reused:true,blocks:JSON.parse(String(known.payload)).blocks};}
   if(tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND operation_id=? AND state IN ('prepared','sending','unknown')",[i.ownerId,operation.id]))fail('memory_extraction_receipt_unknown');
  }else{
   const id=randomUUID();tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state,commit_forbidden_at) VALUES(?,?,?,?,?,?,'prepared',NULL)",[i.ownerId,id,i.purpose,attempt.step_id,slot,seal]);operation=tx.get('SELECT * FROM model_operation WHERE owner_id=? AND id=?',[i.ownerId,id])!;
   for(const item of selected.filter(r=>r.role==='target')){
    assertEffectAvailable(tx,i.ownerId,item.item_id,i.purpose,id);
    tx.run("INSERT INTO operation_item VALUES(?,?,?,?,'reserved')",[i.ownerId,id,item.item_id,i.purpose]);
   }
   for(const c of tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[i.ownerId,task.id]))tx.run("INSERT INTO operation_scope VALUES(?,?,?,?,'reserved')",[i.ownerId,id,c.source_contact_id,i.purpose]);
  }
  occupy(tx,i.ownerId,selected,String(operation.id),i.purpose,'reserved');
  const callId=randomUUID(),requestId=randomUUID();const no=tx.get('SELECT coalesce(max(attempt_no),0)+1 AS n FROM model_call WHERE owner_id=? AND operation_id=?',[i.ownerId,operation.id])!.n;
  tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,step_attempt_id,provider,request_key,state,reserved_budget_units,settlement_state,model,configuration_id,input_cap,output_cap) VALUES(?,?,?,?,?,?,?,'prepared',0,'reserved',?,?,?,?)",[i.ownerId,callId,operation.id,no,i.attemptId,textId(i.provider),requestId,textId(i.model),textId(i.configurationId),i.inputCap,i.outputCap]);
  event(tx,{ownerId:i.ownerId,attemptId:i.attemptId,kind:'model_input',callId,payload:i.request,inputNos:i.inputNos},lease);return {callId,requestId,reused:false};
 }),
 action('reserve','write',(tx,raw,lease)=>{
  const i=raw as {receipt:ModelLedgerReceipt;claim:ModelTaskClaim};validateModelLedgerReceipt(i.receipt);const r=i.receipt;
  const c=tx.get('SELECT * FROM model_call WHERE owner_id=? AND id=? AND request_key=?',[r.owner_id,r.attempt_id,r.request_id]);if(!c||!c.step_attempt_id)fail('memory_extraction_reservation_missing');
  const {attempt,task}=currentAttempt(tx,r.owner_id,String(c!.step_attempt_id),lease);
  if(!i.claim||i.claim.task_id!==task.id||i.claim.step_id!==attempt.step_id||i.claim.step_name!=='extraction_verification'||i.claim.worker_id!==lease.runtimeId||BigInt(i.claim.lease_generation)!==task.resume_no||r.contact_id!==task.contact_id||r.provider!==c!.provider||r.model!==c!.model)fail('memory_extraction_model_scope_invalid');
  const b=r.input_budget;if(!b||b.input_tokens>Number(c!.input_cap)||b.max_output_tokens!==Number(c!.output_cap))return fail('memory_extraction_budget_invalid');
  if(c!.state!=='prepared')fail('memory_extraction_reservation_duplicate');
  tx.run("UPDATE model_call SET state='sending',sent_at=?,reserved_budget_units=?,receipt=? WHERE owner_id=? AND id=?",[Date.now(),b.input_tokens+b.max_output_tokens,JSON.stringify(r),r.owner_id,c!.id]);
  tx.run("UPDATE model_operation SET state='in_flight' WHERE owner_id=? AND id=?",[r.owner_id,c!.operation_id]);
  for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='sent' WHERE owner_id=? AND operation_id=?`,[r.owner_id,c!.operation_id]);return true;
 }),
 action('receipt','write',(tx,raw)=>{
  const r=(raw as {receipt:ModelLedgerReceipt}).receipt;validateModelLedgerReceipt(r);
  const c=tx.get('SELECT c.*,o.state AS op_state,o.purpose AS op_purpose FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.id=? AND c.request_key=?',[r.owner_id,r.attempt_id,r.request_id]);
  if(!c||c.receipt===null||r.provider!==c.provider||r.model!==c.model)return fail('memory_extraction_reservation_missing');
  const old=JSON.parse(String(c.receipt)) as ModelLedgerReceipt&{input_budget_summary?:Record<string,number>};
  const redacted=c.op_state==='sealed'&&c.step_attempt_id===null&&old.input_budget===undefined;
  const sameIdentity=old.attempt_id===r.attempt_id&&old.request_id===r.request_id&&old.owner_id===r.owner_id&&old.permit_id===r.permit_id&&old.contact_id===r.contact_id
   &&(old.scope_kind??'contact')===(r.scope_kind??'contact')&&old.provider===r.provider&&old.model===r.model&&old.called_at===r.called_at;
  const budget=r.input_budget,summary=budgetSummary(budget);
  const sameBudget=redacted?!!summary&&!!old.input_budget_summary&&JSON.stringify(old.input_budget_summary)===JSON.stringify(summary)
   &&BigInt(summary.input_tokens!+summary.max_output_tokens!)===c.reserved_budget_units&&BigInt(summary.max_output_tokens!)===c.output_cap&&BigInt(summary.input_tokens!)<=BigInt(String(c.input_cap))
   :JSON.stringify(old.input_budget)===JSON.stringify(budget);
  if(!sameIdentity||!sameBudget)fail('memory_extraction_receipt_mismatch');
  if(c.state==='succeeded'||c.state==='failed'){if((redacted?minimalModelReceipt(c.receipt)!==minimalModelReceipt(r):c.receipt!==JSON.stringify(r)))fail('memory_extraction_receipt_conflict');return true;}
  const terminalTransport=r.outcome==='failed'&&r.terminal_failure==='transport'&&r.dispatch==='authorized_unconfirmed'
   &&['extraction','verification'].includes(String(c.op_purpose))&&!!tx.get("SELECT 1 FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='model_input' AND json_array_length(payload,'$.images')>0",[r.owner_id,c.id]);
  const unknown=r.outcome==='unknown'||r.outcome==='pending'||r.dispatch==='authorized_unconfirmed'&&!terminalTransport;
  const state=unknown?'unknown':r.outcome==='succeeded'?'succeeded':'failed';
  const usage=r.usage;const actual=usage?usage.input_tokens+usage.output_tokens:null;
  tx.run('UPDATE model_call SET state=?,received_at=?,actual_budget_units=?,settlement_state=?,receipt=? WHERE owner_id=? AND id=?',[state,Date.now(),actual,unknown?'unknown':'settled',redacted?minimalModelReceipt(r):JSON.stringify(r),r.owner_id,c.id]);
  if(c.op_state!=='sealed')tx.run('UPDATE model_operation SET state=? WHERE owner_id=? AND id=?',[unknown?'unknown':state==='succeeded'?'resolved':'failed',r.owner_id,c.operation_id]);
  const documentCall=c.op_purpose==='document_scene'||c.op_purpose==='document_profile';
  const cannotCommit=documentCall&&!tx.get("SELECT 1 FROM step_attempt WHERE owner_id=? AND id=? AND state='running'",[r.owner_id,c.step_attempt_id]);
  const release=state==='failed'||state==='succeeded'&&(c.op_state==='sealed'||cannotCommit);
  if(unknown)for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='unknown' WHERE owner_id=? AND operation_id=?`,[r.owner_id,c.operation_id]);
  if(!unknown&&release)for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id=?`,[r.owner_id,c.operation_id]);
  if(documentCall){
   if(unknown)tx.run("UPDATE document_effect_scope SET state='unknown' WHERE owner_id=? AND operation_id=?",[r.owner_id,c.operation_id]);
   else if(release)tx.run("UPDATE document_effect_scope SET state='released' WHERE owner_id=? AND operation_id=?",[r.owner_id,c.operation_id]);
  }
  return true;
 }),
 action('unconfirmed','read',(tx,raw)=>{const i=raw as {owner_id:string;contact_id:string|null};return tx.all(`SELECT DISTINCT c.request_key FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id JOIN operation_scope s ON s.owner_id=c.owner_id AND s.operation_id=c.operation_id WHERE c.owner_id=? AND o.purpose IN ('extraction','verification','adjudication','relation_verification','merge_verification','document_scene','document_profile') AND c.state IN ('sending','unknown')${i.contact_id===null?'':' AND s.source_contact_id=?'}`,i.contact_id===null?[textId(i.owner_id)]:[textId(i.owner_id),textId(i.contact_id)]).map(c=>String(c.request_key));}),
 action('finish','write',(tx,raw,lease)=>{
  const i=raw as {ownerId:string;attemptId:string;outcome:{accepted:unknown[];extraction_completed:boolean;failure_kind:string|null;rejected_count:number;candidate_trace_ids:string[];verification:{fact:unknown;result:unknown}[]};verificationRefs?:(CandidateVerificationReference|null)[];inputNos:number[];candidateInputNos?:number[][];completedGroups?:{slot:number;inputNos:number[]}[]};const {attempt,task,rows}=currentAttempt(tx,i.ownerId,i.attemptId,lease);
  if(!i.outcome.extraction_completed||i.outcome.failure_kind!==null)fail('memory_extraction_protocol_incomplete');
  const isolated=new Set(isolatedInputs(tx,i.ownerId,String(task.run_id),String(task.contact_id)).map(input=>input.inputNo));
  if(!i.completedGroups&&tx.get("SELECT 1 FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind='image_input_degraded'",[i.ownerId,i.attemptId]))fail('memory_extraction_protocol_incomplete');
  if(tx.get(`SELECT 1 FROM model_call c WHERE c.owner_id=? AND c.step_attempt_id=? AND c.state<>'succeeded'
   AND NOT(c.state='failed' AND c.settlement_state='settled' AND EXISTS(SELECT 1 FROM execution_event e WHERE e.owner_id=c.owner_id AND e.originated_call_id=c.id AND e.kind='image_input_degraded'))`,[i.ownerId,i.attemptId]))fail('memory_extraction_receipt_unknown');
  if(i.completedGroups){
   const covered=i.completedGroups.flatMap(group=>{
    if(!tx.get(`SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
     WHERE c.owner_id=? AND o.memory_step_id=? AND o.slot=? AND o.purpose='extraction' AND c.state='succeeded'`,[i.ownerId,attempt.step_id,group.slot]))fail('memory_extraction_protocol_incomplete');
    return group.inputNos.filter(no=>rows.some(row=>Number(row.input_no)===no&&row.role==='target'));
   });
   const expected=rows.filter(row=>row.role==='target'&&!isolated.has(Number(row.input_no))).map(row=>Number(row.input_no));
   if(covered.length!==expected.length||new Set(covered).size!==covered.length||expected.some(no=>!covered.includes(no)))fail('memory_extraction_protocol_incomplete');
  }
  for(const [index,value] of i.outcome.accepted.entries()){
   const inputNos=i.candidateInputNos?.[index]??i.inputNos;
   const candidateRows=inputNos.map(no=>rows.find(row=>Number(row.input_no)===no)??fail('memory_extraction_input_not_frozen'));
   const f=value as {subject:string;source_message_ids:string[]};if(!f.source_message_ids?.length||!f.source_message_ids.every(id=>candidateRows.some(r=>r.message_id===id&&!isolated.has(Number(r.input_no))))||!f.source_message_ids.some(id=>candidateRows.some(r=>r.message_id===id&&r.role==='target')))fail('memory_extraction_source_stale');
   const verification=i.verificationRefs?.[index]??null;
   if(verification){
    const checked=tx.get("SELECT payload FROM execution_event WHERE owner_id=? AND id=? AND step_attempt_id=? AND kind='verification'",[i.ownerId,verification.eventId,i.attemptId]);
    if(!checked||verification.candidateTraceId!==i.outcome.candidate_trace_ids[index]||!i.outcome.verification.some(v=>JSON.stringify(v.fact)===JSON.stringify(value)&&JSON.stringify(v.result)===JSON.stringify(JSON.parse(String(checked.payload)).result)))fail('memory_extraction_verification_unbound');
   }
   const outputId=event(tx,{ownerId:i.ownerId,attemptId:i.attemptId,kind:f.subject==='self'?'verified_self_contribution':'verified_output',payload:{outputNo:index+1,fact:value,scopeKind:f.subject==='self'?'self':'contact',contactId:f.subject==='self'?null:String(task.contact_id),origin:'auto',state:'verified_pending_decision',verification},inputNos},lease);
   if(verification&&candidateAdmission(tx,i.ownerId,{...tx.get('SELECT * FROM execution_event WHERE owner_id=? AND id=?',[i.ownerId,outputId])!,scope_kind:'contact',run_id:task.run_id},value as Record<string,any>,candidateRows).state!=='verified')fail('memory_extraction_verification_unbound');
  }
  event(tx,{ownerId:i.ownerId,attemptId:i.attemptId,kind:'stage_result',payload:{outcome:isolated.size?'completed_with_isolated_images':i.outcome.accepted.length?'verified_pending_decision':'no_new_memory',isolated:isolated.size,rejected:i.outcome.rejected_count,laterStages:'pending'},inputNos:i.inputNos},lease);
  for(const row of rows.filter(row=>row.role==='target'&&!isolated.has(Number(row.input_no))))tx.run("UPDATE processing_item SET extraction_state='succeeded' WHERE owner_id=? AND id=?",[i.ownerId,row.item_id]);
  tx.run("UPDATE step_attempt SET state='succeeded',finished_at=? WHERE owner_id=? AND id=?",[Date.now(),i.ownerId,i.attemptId]);tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[i.attemptId,i.ownerId,attempt.step_id]);
  tx.run("UPDATE model_operation SET state='applied' WHERE owner_id=? AND memory_step_id=? AND state='resolved'",[i.ownerId,attempt.step_id]);for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id IN (SELECT id FROM model_operation WHERE owner_id=? AND memory_step_id=?)`,[i.ownerId,i.ownerId,attempt.step_id]);return true;
 }),
 action('fail','write',(tx,raw)=>{
  const i=raw as {ownerId:string;attemptId:string;code:string};const a=tx.get('SELECT * FROM step_attempt WHERE owner_id=? AND id=?',[i.ownerId,i.attemptId]);if(!a||a.state!=='running')return false;
  const unknown=i.code==='memory_extraction_receipt_unknown'||!!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state IN ('sending','unknown')",[i.ownerId,i.attemptId]);
  tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id=? AND state='sending'",[i.ownerId,i.attemptId]);
  tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND step_attempt_id=? AND state='prepared'",[i.ownerId,i.attemptId]);
  if(unknown){for(const o of tx.all("SELECT operation_id FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state='unknown'",[i.ownerId,i.attemptId])){tx.run("UPDATE model_operation SET state='unknown' WHERE owner_id=? AND id=? AND state<>'sealed'",[i.ownerId,o.operation_id]);for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='unknown' WHERE owner_id=? AND operation_id=?`,[i.ownerId,o.operation_id]);}}
  if(!unknown){for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id IN (SELECT id FROM model_operation WHERE owner_id=? AND memory_step_id=? AND state NOT IN ('unknown','in_flight','sealed'))`,[i.ownerId,i.ownerId,a.step_id]);const last=tx.get("SELECT o.id FROM model_operation o JOIN model_call c ON c.owner_id=o.owner_id AND c.operation_id=o.id WHERE c.owner_id=? AND c.step_attempt_id=? AND o.state<>'sealed' ORDER BY CASE o.purpose WHEN 'verification' THEN 0 ELSE 1 END,c.attempt_no DESC LIMIT 1",[i.ownerId,i.attemptId]);if(last)tx.run("UPDATE model_operation SET state='failed' WHERE owner_id=? AND id=?",[i.ownerId,last.id]);for(const o of tx.all("SELECT operation_id FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state='failed'",[i.ownerId,i.attemptId])){tx.run("UPDATE model_operation SET state='failed' WHERE owner_id=? AND id=? AND state<>'sealed'",[i.ownerId,o.operation_id]);for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state='released' WHERE owner_id=? AND operation_id=?`,[i.ownerId,o.operation_id]);}}
  const state=unknown?'unknown':'failed';tx.run('UPDATE step_attempt SET state=?,finished_at=?,error_code=? WHERE owner_id=? AND id=?',[state,Date.now(),i.code,i.ownerId,i.attemptId]);tx.run("UPDATE processing_step SET state=? WHERE owner_id=? AND id=? AND state<>'revoked'",[state,i.ownerId,a.step_id]);
  tx.run("UPDATE processing_task SET state=?,error_code=? WHERE owner_id=? AND id=(SELECT task_id FROM processing_step WHERE owner_id=? AND id=?) AND state<>'revoked'",[state,i.code,i.ownerId,i.ownerId,a.step_id]);return true;
 }),
 action('control','write',(tx,raw)=>{
  const input=raw as {ownerId:string;runId:string;action:'pause'|'continue';actionVersion?:number;operationId?:string};
  reconcile(tx,textId(input.ownerId),textId(input.runId));
  const applied=applyControl(tx,input);
  return {...snapshot(tx,applied.ownerId,applied.runId),replayed:applied.replayed};
 }),
 /** 用户放弃裁决类未知调用并重试：先释放占位，再按继续语义推进控制修订；原请求不重发。 */
 action('abandonUnknown','write',(tx,raw)=>{
  const input=raw as {ownerId:string;runId:string;actionVersion?:number;operationId?:string};
  reconcile(tx,textId(input.ownerId),textId(input.runId));
  abandonUnknownAdjudication(tx,input);
  const applied=applyControl(tx,{ownerId:input.ownerId,runId:input.runId,action:'continue'});
  // 运行态已是继续中时 continue 为空操作，仍须推进修订才能让重新裁决领取新尝试。
  if(applied.replayed)tx.run('UPDATE processing_run SET intent_revision=intent_revision+1 WHERE owner_id=? AND id=?',[applied.ownerId,applied.runId]);
  return {...snapshot(tx,applied.ownerId,applied.runId),replayed:false};
 }),
 action('settleRun','write',(tx,raw,lease)=>{
  const i=raw as {ownerId:string;runId:string;laterWork?:boolean};reconcile(tx,i.ownerId,i.runId);
  const tasks=tx.all("SELECT * FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='contact'",[i.ownerId,i.runId]);
  if(tasks.every(t=>t.state==='succeeded'))finalizeOwnerContributions(tx,i,lease);
  tx.run("UPDATE processing_run SET state=CASE WHEN pause_requested_at IS NOT NULL THEN 'paused' WHEN EXISTS(SELECT 1 FROM processing_task t WHERE t.owner_id=processing_run.owner_id AND t.run_id=processing_run.id AND t.state='failed') THEN 'failed' WHEN ? THEN 'running' ELSE 'incomplete' END WHERE owner_id=? AND id=? AND state<>'revoked'",[i.laterWork?1:0,i.ownerId,i.runId]);return snapshot(tx,i.ownerId,i.runId);
 }),
 action('finishLater','write',(tx,raw)=>{
  const i=raw as {ownerId:string;runId:string};
  tx.run("UPDATE processing_run SET state=CASE WHEN pause_requested_at IS NOT NULL THEN 'paused' WHEN EXISTS(SELECT 1 FROM processing_task t WHERE t.owner_id=processing_run.owner_id AND t.run_id=processing_run.id AND t.state='failed') THEN 'failed' ELSE 'incomplete' END WHERE owner_id=? AND id=? AND state='running'",[i.ownerId,i.runId]);return snapshot(tx,i.ownerId,i.runId);
 }),
 action('recover','write',(tx,raw,lease)=>{
  const {ownerId}=raw as {ownerId:string};
  for(const a of tx.all("SELECT * FROM step_attempt WHERE owner_id=? AND state='running' AND runtime_token<>? AND step_id IN (SELECT id FROM processing_step WHERE kind='extraction_verification')",[ownerId,lease.runtimeId])){
   tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id=? AND state='sending'",[ownerId,a.id]);
   tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND step_attempt_id=? AND state='prepared'",[ownerId,a.id]);
   const unknown=!!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state='unknown'",[ownerId,a.id]);
   for(const call of tx.all('SELECT operation_id,state FROM model_call WHERE owner_id=? AND step_attempt_id=?',[ownerId,a.id])){if(call.state==='unknown'||call.state==='failed'){tx.run("UPDATE model_operation SET state=? WHERE owner_id=? AND id=? AND state<>'sealed'",[call.state,ownerId,call.operation_id]);for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state=? WHERE owner_id=? AND operation_id=?`,[call.state==='unknown'?'unknown':'released',ownerId,call.operation_id]);}}
   tx.run("UPDATE step_attempt SET state=?,error_code='runtime_interrupted' WHERE owner_id=? AND id=?",[unknown?'unknown':'aborted',ownerId,a.id]);
   tx.run('UPDATE processing_step SET state=? WHERE owner_id=? AND id=?',[unknown?'unknown':'failed',ownerId,a.step_id]);
   tx.run("UPDATE processing_task SET state=?,error_code='memory_extraction_interrupted' WHERE owner_id=? AND id=(SELECT task_id FROM processing_step WHERE owner_id=? AND id=?) AND state<>'revoked'",[unknown?'unknown':'failed',ownerId,ownerId,a.step_id]);
  }
  // 安全恢复停在L1结算与后续登记之间的持久轮；仅接受新标记的轮次，旧incomplete历史不作猜测。
  if(hasRunFollowupState(tx))for(const run of tx.all(`SELECT * FROM processing_run WHERE owner_id=? AND state='running' AND followup_state IN ('pending','enrolled')
   AND pause_requested_at IS NULL AND coalesce(json_extract(policy_config,'$.intent'),'')<>'memory_document_later_stage'`,[ownerId])){
   const runId=String(run.id),tasks=tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=?',[ownerId,runId]);
   if(!tasks.length||tasks.some(task=>!['succeeded','awaiting_decision','incomplete'].includes(String(task.state))||task.state==='incomplete'&&(task.scope_kind!=='contact'||task.error_code!=='targets_completed_elsewhere')))continue;
   if(tx.get(`SELECT 1 FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE s.owner_id=? AND t.run_id=? AND s.state IN ('failed','unknown','paused','pending','running') LIMIT 1`,[ownerId,runId]))continue;
   if(tx.get(`SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
    JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
    WHERE c.owner_id=? AND t.run_id=? AND c.state IN ('unknown','sending','prepared') LIMIT 1`,[ownerId,runId]))continue;
   const targets=tx.all(`SELECT p.extraction_state FROM run_input i JOIN processing_item p ON p.owner_id=i.owner_id AND p.id=i.item_id
    WHERE i.owner_id=? AND i.run_id=? AND i.role='target'`,[ownerId,runId]);
   if(!targets.length||targets.some(item=>item.extraction_state!=='succeeded'))continue;
   let qualified=true;
   for(const task of tasks)try{for(const contribution of tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[ownerId,task.id]))assertContribution(tx,ownerId,runId,String(contribution.source_contact_id));}
    catch{qualified=false;break;}
   if(!qualified)continue;
   try{assertInputs(tx,ownerId,runId,tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=?',[ownerId,runId]));}catch{continue;}
   tx.run("UPDATE processing_run SET state='incomplete' WHERE owner_id=? AND id=? AND state='running' AND followup_state IN ('pending','enrolled') AND pause_requested_at IS NULL",[ownerId,runId]);
  }
  // 应用退出不是用户暂停；未发送或已取得确定回执的L1可沿原输入继续，未知调用仍保持未知。
  tx.run(`UPDATE processing_task SET state='failed',error_code='memory_extraction_interrupted'
   WHERE owner_id=? AND scope_kind='contact' AND state IN ('pending','running')
    AND EXISTS(SELECT 1 FROM processing_run r WHERE r.owner_id=processing_task.owner_id AND r.id=processing_task.run_id AND r.state IN ('running','pending') AND r.pause_requested_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM processing_step s WHERE s.owner_id=processing_task.owner_id AND s.task_id=processing_task.id AND s.state IN ('running','unknown'))`,[ownerId]);
  tx.run("UPDATE processing_run SET state=CASE WHEN pause_requested_at IS NULL THEN 'incomplete' ELSE 'paused' END WHERE owner_id=? AND state IN ('running','pending')",[ownerId]);
  retireStalePausedRuns(tx,ownerId);return true;
 }),
 action('trace','read',(tx,raw)=>{
  const i=raw as {ownerId:string;taskId:string};const t=tx.get('SELECT * FROM processing_task WHERE owner_id=? AND id=?',[textId(i.ownerId),textId(i.taskId)]);if(!t||t.state==='revoked')fail('memory_extraction_not_found');
  const deps=tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[i.ownerId,i.taskId]);for(const c of deps)assertContribution(tx,i.ownerId,String(t!.run_id),String(c.source_contact_id));
  const events=tx.all(`SELECT e.* FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE s.owner_id=? AND s.task_id=? ORDER BY a.started_at,e.event_no`,[i.ownerId,i.taskId]).map(e=>({eventId:String(e.id),attemptId:String(e.step_attempt_id),kind:String(e.kind),payload:JSON.parse(String(e.payload)),callId:e.originated_call_id??e.reused_call_id,
   inputNos:tx.all(`SELECT si.run_input_no FROM execution_input x JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no WHERE x.owner_id=? AND x.event_id=? ORDER BY x.presentation_no`,[i.ownerId,e.id]).map(x=>Number(x.run_input_no)),sources:tx.all('SELECT source_contact_id,record_id FROM event_source WHERE owner_id=? AND event_id=?',[i.ownerId,e.id]).map(x=>({contactId:String(x.source_contact_id),recordId:String(x.record_id)}))}));
  const calls=tx.all(`SELECT c.*,o.purpose FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id WHERE s.owner_id=? AND s.task_id=? ORDER BY c.attempt_no`,[i.ownerId,i.taskId]).map(c=>({callId:String(c.id),operationId:String(c.operation_id),purpose:String(c.purpose),state:String(c.state),provider:String(c.provider),requestKey:String(c.request_key),reservedBudgetUnits:String(c.reserved_budget_units),actualBudgetUnits:c.actual_budget_units===null?null:String(c.actual_budget_units)}));return {events,calls};
 })];
