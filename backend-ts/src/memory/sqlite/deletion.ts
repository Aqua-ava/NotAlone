/** 按实际事件与输入清理来源；独立成功产物保留，待执行任务统一撤销。 */
import {createHash} from 'node:crypto';
import {StorageFailure,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {CheckResult,DeletionDomain,DeletionOperation,RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';
import {identityDeletionAuthority} from '../../contacts/sqlite/deletion.ts';
import {isMediaDeletionScope,mediaDeletionAuthority} from '../../media/sqlite/deletion.ts';
import {memoryDeletionImpact,deletionRows,deletionIds} from './deletion-impact.ts';
import {minimalModelReceipt} from './execution.ts';
import {deletionTargetKey} from '../../storage/sqlite/deletion/actions.ts';

const domain='memory_extraction';
const rowKinds:DeletionDomain['rowKinds']={
  event_source:{keys:['owner_id','event_id','record_id'],ownerKey:'owner_id'},
  execution_input:{keys:['owner_id','event_id','input_no'],ownerKey:'owner_id'},
  execution_event:{keys:['owner_id','id'],ownerKey:'owner_id'},
  step_input:{keys:['owner_id','step_id','input_no'],ownerKey:'owner_id'},
  model_call:{keys:['owner_id','id'],ownerKey:'owner_id'},
  operation_item:{keys:['owner_id','operation_id','item_id','effect_kind'],ownerKey:'owner_id'},
  operation_scope:{keys:['owner_id','operation_id','source_contact_id','effect_kind'],ownerKey:'owner_id'},
  model_operation:{keys:['owner_id','id'],ownerKey:'owner_id'},
  step_attempt:{keys:['owner_id','id'],ownerKey:'owner_id'},
  processing_step:{keys:['owner_id','id'],ownerKey:'owner_id'},
  task_contribution:{keys:['owner_id','task_id','source_contact_id'],ownerKey:'owner_id'},
  processing_task:{keys:['owner_id','id'],ownerKey:'owner_id'},
  run_input:{keys:['owner_id','run_id','input_no'],ownerKey:'owner_id'},
  run_contact:{keys:['owner_id','run_id','contact_id'],ownerKey:'owner_id'},
  processing_item:{keys:['owner_id','id'],ownerKey:'owner_id'},
  processing_run:{keys:['owner_id','id'],ownerKey:'owner_id'},
};
const allowed=(op:DeletionOperation)=>isMediaDeletionScope(op.scope)||['source','contact_history','contact','account'].includes(op.scope.kind);
const verifyFence=(tx:StorageTransaction,op:DeletionOperation)=>isMediaDeletionScope(op.scope)?mediaDeletionAuthority.verify(tx,op):identityDeletionAuthority.verify(tx,op);
const eraseLedger=(op:DeletionOperation)=>op.scope.kind==='contact'||op.scope.kind==='account';
// 删除来源只撤销提交资格；未决发送的逐消息效果身份仍须阻止换来源或换轮重发。
function preserveUnknownOccupation(tx:StorageTransaction,op:DeletionOperation,row:StorageRow):boolean {
  return !eraseLedger(op)&&row.state==='unknown'&&!!tx.get(
    "SELECT 1 FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND c.operation_id=? AND c.state IN ('sending','unknown') AND o.state='sealed' AND o.commit_forbidden_at IS NOT NULL",
    [op.ownerId,row.operation_id]);
}
const fail=(code:string):never=>{throw new StorageFailure(code);};
const pass=(proof:string):CheckResult=>({result:'passed',proof});
const check=(ok:boolean,proof:string):CheckResult=>({result:ok?'passed':'blocked',proof});
const address=(kind:string,key:Record<string,string>)=>createHash('sha256').update(JSON.stringify([kind,Object.entries(key).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
function fenced(tx:StorageTransaction,op:DeletionOperation):void {
  if(verifyFence(tx,op).result!=='passed')fail('memory_deletion_not_fenced');
}
function oldTargets(tx:StorageTransaction,op:DeletionOperation):Map<string,RowDeletionTarget> {
  const found=new Map<string,RowDeletionTarget>();
  for(const row of tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain=? AND target_payload IS NOT NULL",[op.operationId,domain])){
    const target=JSON.parse(String(row.target_payload)) as RowDeletionTarget;found.set(target.identity,target);
  }
  return found;
}
interface Closure {
  tasks:StorageRow[];removedTasks:StorageRow[];steps:StorageRow[];attempts:StorageRow[];events:StorageRow[];operations:StorageRow[];
  stepInputs:StorageRow[];contributions:StorageRow[];inputs:StorageRow[];contacts:StorageRow[];items:StorageRow[];runs:StorageRow[];
}
function closure(tx:StorageTransaction,op:DeletionOperation):Closure {
  const empty:Closure={tasks:[],removedTasks:[],steps:[],attempts:[],events:[],operations:[],stepInputs:[],contributions:[],inputs:[],contacts:[],items:[],runs:[]};
  if(!allowed(op))return empty;
  const {ownerId,scope}=op,impact=memoryDeletionImpact(tx,op);
  const tasks=deletionRows(tx,ownerId,'processing_task','id',impact.tasks),touched=deletionRows(tx,ownerId,'processing_step','id',impact.steps);
  const events=deletionRows(tx,ownerId,'execution_event','id',impact.events),affectedEvents=deletionIds(impact.events);
  const touchedAttempts=deletionRows(tx,ownerId,'step_attempt','step_id',impact.steps);
  const attempts=touchedAttempts.filter(a=>!tx.get('SELECT 1 FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1',[ownerId,a.id,affectedEvents]));
  const attemptIds=attempts.map(a=>String(a.id));
  const steps=touched.filter(step=>!tx.get('SELECT 1 FROM step_attempt WHERE owner_id=? AND step_id=? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1',[ownerId,step.id,deletionIds(attemptIds)]));
  const stepIds=steps.map(step=>String(step.id));
  const removedTasks=tasks.filter(task=>!tx.get('SELECT 1 FROM processing_step WHERE owner_id=? AND task_id=? AND id NOT IN (SELECT value FROM json_each(?)) LIMIT 1',[ownerId,task.id,deletionIds(stepIds)]));
  const removedTaskIds=removedTasks.map(task=>String(task.id));
  const stepInputMap=new Map<string,StorageRow>();
  for(const row of deletionRows(tx,ownerId,'step_input','step_id',stepIds))stepInputMap.set(deletionIds([row.step_id,row.input_no]),row);
  for(const i of impact.stepInputs){const row=tx.get('SELECT * FROM step_input WHERE owner_id=? AND step_id=? AND input_no=?',[ownerId,i.stepId,i.inputNo]);if(row)stepInputMap.set(deletionIds([row.step_id,row.input_no]),row);}
  const contributions=deletionRows(tx,ownerId,'task_contribution','task_id',removedTaskIds);
  if(scope.kind==='contact')for(const task of tasks)if(!removedTaskIds.includes(String(task.id))){const row=tx.get('SELECT * FROM task_contribution WHERE owner_id=? AND task_id=? AND source_contact_id=?',[ownerId,task.id,scope.contactId]);if(row)contributions.push(row);}
  const ledgerScope=new Set<string>();
  if(scope.kind==='account')for(const o of tx.all("SELECT id FROM model_operation WHERE owner_id=? AND reply_request_id IS NULL",[ownerId]))ledgerScope.add(String(o.id));
  else if(eraseLedger(op)&&'contactId'in scope)for(const o of tx.all('SELECT operation_id FROM operation_scope WHERE owner_id=? AND source_contact_id=?',[ownerId,scope.contactId]))ledgerScope.add(String(o.operation_id));
  for(const target of impact.planned)if(target.domain===domain&&target.rowKind==='model_operation')ledgerScope.add(target.key.id);
  for(const o of deletionRows(tx,ownerId,'model_operation','memory_step_id',impact.steps))ledgerScope.add(String(o.id));
  const operations=ledgerScope.size?tx.all("SELECT * FROM model_operation WHERE owner_id=? AND id IN (SELECT value FROM json_each(?)) AND purpose IN ('extraction','verification','adjudication','relation_verification','merge_verification','document_scene','document_profile') AND reply_request_id IS NULL ORDER BY id",[ownerId,deletionIds([...ledgerScope])]):[];
  const pairs=new Map<string,{run:string;contact:string}>();
  const pair=(run:unknown,contact:unknown)=>pairs.set(deletionIds([run,contact]),{run:String(run),contact:String(contact)});
  for(const i of impact.inputs)pair(i.run_id,i.source_contact_id);
  for(const c of contributions)pair(c.run_id,c.source_contact_id);
  for(const t of impact.planned)if(t.domain===domain&&t.rowKind==='run_contact')pair(t.key.run_id,t.key.contact_id);
  if(scope.kind==='account')for(const c of tx.all('SELECT run_id,contact_id FROM run_contact WHERE owner_id=?',[ownerId]))pair(c.run_id,c.contact_id);
  const contributionKeys=new Set(contributions.map(c=>deletionIds([c.task_id,c.source_contact_id]))),contacts:StorageRow[]=[];
  for(const {run,contact} of pairs.values()){
    const row=tx.get('SELECT * FROM run_contact WHERE owner_id=? AND run_id=? AND contact_id=?',[ownerId,run,contact]);if(!row)continue;
    const inputNos=impact.inputs.filter(i=>i.run_id===run||String(i.run_id)===String(run)).map(i=>String(i.input_no));
    if(tx.get('SELECT 1 FROM run_input WHERE owner_id=? AND run_id=? AND source_contact_id=? AND input_no NOT IN (SELECT value FROM json_each(?)) LIMIT 1',[ownerId,run,contact,deletionIds(inputNos)]))continue;
    const needed=tx.all(`SELECT c.task_id,c.source_contact_id FROM processing_task t INDEXED BY task_contact_scope JOIN task_contribution c ON c.owner_id=t.owner_id AND c.task_id=t.id AND c.source_contact_id=? WHERE t.owner_id=? AND t.run_id=? AND t.scope_kind='contact' AND t.contact_id=?
      UNION ALL SELECT c.task_id,c.source_contact_id FROM processing_task t INDEXED BY task_self_scope JOIN task_contribution c ON c.owner_id=t.owner_id AND c.task_id=t.id AND c.source_contact_id=? WHERE t.owner_id=? AND t.run_id=? AND t.scope_kind='self'`,[contact,ownerId,run,contact,contact,ownerId,run]);
    if(needed.some(c=>!contributionKeys.has(deletionIds([c.task_id,c.source_contact_id]))))continue;
    contacts.push(row);
  }
  const itemIds=new Set(impact.inputs.filter(i=>i.item_id!==null).map(i=>String(i.item_id)));
  for(const t of impact.planned)if(t.domain===domain&&t.rowKind==='processing_item')itemIds.add(t.key.id);
  for(const i of deletionRows(tx,ownerId,'operation_item','operation_id',operations.map(o=>String(o.id))))if(['extraction','verification'].includes(String(i.effect_kind)))itemIds.add(String(i.item_id));
  const items=scope.kind==='account'?tx.all('SELECT * FROM processing_item WHERE owner_id=?',[ownerId]):scope.kind==='contact'?tx.all('SELECT * FROM processing_item WHERE owner_id=? AND contact_id=?',[ownerId,scope.contactId]):deletionRows(tx,ownerId,'processing_item','id',[...itemIds]);
  const runIds=new Set([...tasks.map(t=>String(t.run_id)),...impact.inputs.map(i=>String(i.run_id)),...contacts.map(c=>String(c.run_id))]);
  for(const t of impact.planned)if(t.domain===domain&&t.rowKind==='processing_run')runIds.add(t.key.id);
  if(scope.kind==='account')for(const r of tx.all('SELECT id FROM processing_run WHERE owner_id=?',[ownerId]))runIds.add(String(r.id));
  const runs=deletionRows(tx,ownerId,'processing_run','id',[...runIds]).filter(r=>
    !tx.get(`SELECT 1 FROM (SELECT id FROM processing_task INDEXED BY task_contact_scope WHERE owner_id=? AND run_id=? AND scope_kind='contact'
      UNION ALL SELECT id FROM processing_task INDEXED BY task_self_scope WHERE owner_id=? AND run_id=? AND scope_kind='self') WHERE id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`,[ownerId,r.id,ownerId,r.id,deletionIds(removedTaskIds)])
    &&!tx.get('SELECT 1 FROM run_input WHERE owner_id=? AND run_id=? AND input_no NOT IN (SELECT value FROM json_each(?)) LIMIT 1',[ownerId,r.id,deletionIds(impact.inputs.filter(i=>i.run_id===r.id).map(i=>String(i.input_no)))])
    &&!tx.get('SELECT 1 FROM run_contact WHERE owner_id=? AND run_id=? AND contact_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1',[ownerId,r.id,deletionIds(contacts.filter(c=>c.run_id===r.id).map(c=>String(c.contact_id)))]));
  return {tasks,removedTasks,steps,attempts,events,operations,stepInputs:[...stepInputMap.values()],contributions,inputs:impact.inputs,contacts,items,runs};
}
function collect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[] {
  if(!allowed(op))return [];
  fenced(tx,op);const c=closure(tx,op),old=oldTargets(tx,op);
  const holders=c.tasks.map(t=>`memory:${t.id}`).sort(),targets:RowDeletionTarget[]=[];
  const add=(kind:string,row:StorageRow)=>{
    const key=Object.fromEntries(rowKinds[kind].keys.map(k=>[k,String(row[k])])),identity=address(kind,key);
    targets.push(old.get(identity)??{kind:'row',domain,rowKind:kind,key,identity,holderKeys:holders});
  };
  const eventIds=c.events.map(e=>String(e.id)),stepIds=new Set(c.steps.map(s=>String(s.id))),attemptIds=new Set(c.attempts.map(a=>String(a.id))),operationIds=c.operations.map(o=>String(o.id));
  for(const kind of ['event_source','execution_input'])deletionRows(tx,op.ownerId,kind,'event_id',eventIds).forEach(r=>add(kind,r));
  c.events.forEach(r=>add('execution_event',r));c.stepInputs.forEach(r=>add('step_input',r));
  for(const row of deletionRows(tx,op.ownerId,'model_call','operation_id',operationIds))if(eraseLedger(op)||attemptIds.has(String(row.step_attempt_id)))add('model_call',row);
  for(const row of deletionRows(tx,op.ownerId,'operation_item','operation_id',operationIds))if(!preserveUnknownOccupation(tx,op,row))add('operation_item',row);
  if(eraseLedger(op))deletionRows(tx,op.ownerId,'operation_scope','operation_id',operationIds).forEach(r=>add('operation_scope',r));
  c.operations.filter(o=>eraseLedger(op)||stepIds.has(String(o.memory_step_id))).forEach(r=>add('model_operation',r));
  c.attempts.forEach(r=>add('step_attempt',r));c.steps.forEach(r=>add('processing_step',r));
  c.contributions.forEach(r=>add('task_contribution',r));c.removedTasks.forEach(r=>add('processing_task',r));
  c.inputs.forEach(r=>add('run_input',r));c.contacts.forEach(r=>add('run_contact',r));
  c.items.filter(i=>eraseLedger(op)||i.message_id!==null).forEach(r=>add('processing_item',r));c.runs.forEach(r=>add('processing_run',r));return targets;
}
export const memoryExtractionDeletionDomain:DeletionDomain={
  id:domain,rowKinds,
  fence(tx,op){
    if(!allowed(op))return [];
    fenced(tx,op);const c=closure(tx,op),now=Date.now();
    for(const task of c.tasks)tx.run("UPDATE processing_task SET state='revoked',control_revision=control_revision+1,error_code='source_deleted' WHERE owner_id=? AND id=? AND state<>'revoked'",[op.ownerId,task.id]);
    const documentSteps=!!tx.get("SELECT 1 FROM pragma_table_info('processing_step') WHERE name='not_applicable_reason'");
    for(const step of c.steps)tx.run(documentSteps?"UPDATE processing_step SET state='revoked',successful_attempt_id=NULL,not_applicable_reason=NULL WHERE owner_id=? AND id=?":"UPDATE processing_step SET state='revoked',successful_attempt_id=NULL WHERE owner_id=? AND id=?",[op.ownerId,step.id]);
    for(const attempt of c.attempts)tx.run("UPDATE processing_item SET pipeline_state='pending',completion_attempt_id=NULL WHERE owner_id=? AND completion_attempt_id=? AND pipeline_state='completed'",[op.ownerId,attempt.id]);
    for(const attempt of c.attempts)tx.run("UPDATE step_attempt SET state='aborted',finished_at=?,error_code='source_deleted' WHERE owner_id=? AND id=? AND state='running'",[now,op.ownerId,attempt.id]);
    for(const item of c.items)tx.run("UPDATE processing_item SET extraction_state='invalidated' WHERE owner_id=? AND id=? AND extraction_state NOT IN ('invalidated','deleted')",[op.ownerId,item.id]);
    for(const operation of c.operations)tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=COALESCE(commit_forbidden_at,?),input_seal='deleted' WHERE owner_id=? AND id=?",[now,op.ownerId,operation.id]);
    if(!eraseLedger(op))for(const operation of c.operations)tx.run("UPDATE operation_item SET state='unknown' WHERE owner_id=? AND operation_id=? AND EXISTS(SELECT 1 FROM model_call WHERE owner_id=? AND operation_id=? AND state IN ('sending','unknown'))",[op.ownerId,operation.id,op.ownerId,operation.id]);
    const affectedRuns=new Set(c.tasks.map(t=>String(t.run_id))),wholeRuns=new Set(c.runs.map(r=>String(r.id)));
    for(const runId of affectedRuns)tx.run('UPDATE processing_run SET state=? WHERE owner_id=? AND id=?',[wholeRuns.has(runId)?'revoked':'incomplete',op.ownerId,runId]);
    const requests=op.scope.kind==='account'?tx.all('SELECT start_request_key,id FROM processing_run WHERE owner_id=?',[op.ownerId]):deletionRows(tx,op.ownerId,'processing_run','id',[...affectedRuns]);
    return requests.map(r=>({namespace:'memoryExtraction.start',key:String(r.start_request_key)}));
  },
  collect,
  clearRow(tx,op,target){
    if(!allowed(op)||target.domain!==domain||!Object.hasOwn(rowKinds,target.rowKind)||target.key.owner_id!==op.ownerId
      ||Object.keys(target.key).sort().join()!==[...rowKinds[target.rowKind].keys].sort().join()
      ||target.identity!==address(target.rowKind,target.key))fail('memory_deletion_target_invalid');
    fenced(tx,op);
    // 按账本唯一键（operation_id,domain,target_key）点查：旧写法按 expected_identity 无索引扫描本操作的全部目标，目标数 N 时总量是 N 的平方。
    if(!tx.get('SELECT 1 FROM deletion_target WHERE operation_id=? AND domain=? AND target_key=? AND target_payload IS NOT NULL',
      [op.operationId,domain,deletionTargetKey(target)]))fail('memory_deletion_target_unplanned');
    const keys=rowKinds[target.rowKind].keys,where=keys.map(k=>`${k}=?`).join(' AND '),args=keys.map(k=>target.key[k]);
    if(target.rowKind==='model_call'&&!eraseLedger(op)){
      const call=tx.get(`SELECT receipt FROM model_call WHERE ${where}`,args);
      if(call)tx.run(`UPDATE model_call SET step_attempt_id=NULL,receipt=? WHERE ${where}`,[minimalModelReceipt(call.receipt),...args]);
    }else if(target.rowKind==='model_operation'&&!eraseLedger(op)){
      tx.run(`UPDATE model_operation SET memory_step_id=NULL,state='sealed',input_seal='deleted' WHERE ${where}`,args);
    }else if(target.rowKind==='operation_item'&&!eraseLedger(op)){
      const item=tx.get(`SELECT * FROM operation_item WHERE ${where}`,args);
      if(item&&preserveUnknownOccupation(tx,op,item))return;
      tx.run(`DELETE FROM operation_item WHERE ${where}`,args);
    }else if(target.rowKind==='processing_item'&&!eraseLedger(op)){
      const item=tx.get(`SELECT * FROM processing_item WHERE ${where}`,args);if(!item)return;
      const preserved=tx.get("SELECT 1 FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND availability='available' AND state='normalized'",[op.ownerId,item.contact_id,item.message_id]);
      // 换图只撤销旧文件的执行；合法新副本仍是该消息待处理工作。未知发送的效果占用不能借换图重发。
      const replacement=op.scope.kind==='media_result_replace'&&op.scope.contactId===item.contact_id&&op.scope.messageId===item.message_id
        &&tx.get("SELECT 1 FROM media_file f JOIN message_media h ON h.owner_id=f.owner_id AND h.contact_id=f.contact_id AND h.message_id=f.message_id WHERE f.owner_id=? AND f.contact_id=? AND f.message_id=? AND f.role='image_display' AND f.publish_state='current' AND f.content_state='present' AND f.container_valid=1 AND f.viewable=1 AND h.state<>'cleared'",[op.ownerId,item.contact_id,item.message_id])
        &&!tx.get("SELECT 1 FROM operation_item WHERE owner_id=? AND item_id=? AND state='unknown'",[op.ownerId,item.id]);
      if(preserved)tx.run(`UPDATE processing_item SET extraction_state=? WHERE ${where}`,[replacement?'pending':'invalidated',...args]);
      else tx.run(`UPDATE processing_item SET message_id=NULL,extraction_state='deleted',pipeline_state='deleted',completion_attempt_id=NULL WHERE ${where}`,args);
    }else{
      if(target.rowKind==='run_input'&&tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_content_input'"))tx.run('DELETE FROM run_content_input WHERE owner_id=? AND run_id=? AND input_no=?',[op.ownerId,target.key.run_id,BigInt(target.key.input_no)]);
      tx.run(`DELETE FROM ${target.rowKind} WHERE ${where}`,args);
    }
  },
  authorizeFile(){fail('memory_extraction_has_no_managed_files');},
  fileCleared(){fail('memory_extraction_has_no_managed_files');},
  verify(tx,op){
    if(!allowed(op)){const na:CheckResult={result:'not_applicable',proof:'memory_scope_not_owned'};return {database_rows:na,derived_eligibility:na,trace_payloads:na,request_replay:na,scope_suppression:na};}
    const targets=collect(tx,op),empty=targets.length===0;
    const remaining=closure(tx,op);
    const late=remaining.tasks.some(t=>t.state!=='revoked')||remaining.operations.some(o=>o.commit_forbidden_at===null);
    const tombstones=tx.get('SELECT count(*) n FROM request_tombstone WHERE owner_identity=? AND deletion_operation_id=?',[op.ownerId,op.operationId])!.n;
    const haveRequests=remaining.tasks.length>0||remaining.runs.length>0;
    return {database_rows:check(empty,'memory_deletion_rows'),derived_eligibility:check(!late,'memory_old_writers_revoked'),
      trace_payloads:check(remaining.events.length===0,'memory_process_payloads_cleared'),
      request_replay:check(!haveRequests||tombstones!==0n,'memory_start_requests_tombstoned'),
      scope_suppression:verifyFence(tx,op).result==='passed'?pass('memory_identity_fence_current'):{result:'blocked',proof:'memory_identity_fence_missing'}};
  },
};
