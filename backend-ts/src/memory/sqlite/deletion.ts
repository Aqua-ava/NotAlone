/** 记忆提取的真实来源闭包；混合本人结果整体失效，其他联系人的任务保持独立。 */
import {createHash} from 'node:crypto';
import {StorageFailure,type StorageRow,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {CheckResult,DeletionDomain,DeletionOperation,RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';
import {identityDeletionAuthority} from '../../contacts/sqlite/deletion.ts';

const domain='memory_extraction';
const rowKinds:DeletionDomain['rowKinds']={
  execution_reuse:{keys:['owner_id','event_id'],ownerKey:'owner_id'},
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
const allowed=(op:DeletionOperation)=>['source','contact_history','contact','account'].includes(op.scope.kind);
const eraseLedger=(op:DeletionOperation)=>op.scope.kind==='contact'||op.scope.kind==='account';
const fail=(code:string):never=>{throw new StorageFailure(code);};
const pass=(proof:string):CheckResult=>({result:'passed',proof});
const check=(ok:boolean,proof:string):CheckResult=>({result:ok?'passed':'blocked',proof});
const address=(kind:string,key:Record<string,string>)=>createHash('sha256').update(JSON.stringify([kind,Object.entries(key).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
function fenced(tx:StorageTransaction,op:DeletionOperation):void {
  if(identityDeletionAuthority.verify(tx,op).result!=='passed')fail('memory_deletion_not_fenced');
}
function oldTargets(tx:StorageTransaction,op:DeletionOperation):Map<string,RowDeletionTarget> {
  const found=new Map<string,RowDeletionTarget>();
  for(const row of tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain=? AND target_payload IS NOT NULL",[op.operationId,domain])){
    const target=JSON.parse(String(row.target_payload)) as RowDeletionTarget;found.set(target.identity,target);
  }
  return found;
}
interface Closure {
  tasks:StorageRow[];steps:StorageRow[];attempts:StorageRow[];events:StorageRow[];operations:StorageRow[];
  inputs:StorageRow[];contacts:StorageRow[];items:StorageRow[];runs:StorageRow[];
}
function closure(tx:StorageTransaction,op:DeletionOperation):Closure {
  const empty:Closure={tasks:[],steps:[],attempts:[],events:[],operations:[],inputs:[],contacts:[],items:[],runs:[]};
  if(!allowed(op))return empty;
  const {ownerId,scope}=op;
  const allTasks=tx.all('SELECT * FROM processing_task WHERE owner_id=? ORDER BY id',[ownerId]);
  const allContacts=tx.all('SELECT * FROM run_contact WHERE owner_id=? ORDER BY run_id,contact_id',[ownerId]);
  const pairs=new Set<string>(),taskIds=new Set<string>();
  const pair=(run:unknown,contact:unknown)=>JSON.stringify([String(run),String(contact)]);
  if(scope.kind==='account'){
    for(const contact of allContacts)pairs.add(pair(contact.run_id,contact.contact_id));
    for(const task of allTasks)taskIds.add(String(task.id));
  }else if('contactId'in scope){
    if(scope.kind==='source'){
      for(const row of tx.all('SELECT run_id FROM run_input WHERE owner_id=? AND source_contact_id=? AND record_id=?',[ownerId,scope.contactId,scope.sourceId]))
        pairs.add(pair(row.run_id,scope.contactId));
      // 实际来源依赖独立复核，不能只依赖候选展示引用。
      for(const row of tx.all(`SELECT t.id,t.run_id FROM event_source es
        JOIN execution_event e ON e.owner_id=es.owner_id AND e.id=es.event_id
        JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
        JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
        JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
        WHERE es.owner_id=? AND es.source_contact_id=? AND es.record_id=?`,[ownerId,scope.contactId,scope.sourceId])){
        pairs.add(pair(row.run_id,scope.contactId));taskIds.add(String(row.id));
      }
    }else{
      for(const contact of allContacts)if(contact.contact_id===scope.contactId
        &&(contact.accepted_data_generation as bigint)<op.acceptedGeneration)pairs.add(pair(contact.run_id,contact.contact_id));
    }
    for(const contribution of tx.all('SELECT task_id,run_id,source_contact_id FROM task_contribution WHERE owner_id=?',[ownerId]))
      if(pairs.has(pair(contribution.run_id,contribution.source_contact_id)))taskIds.add(String(contribution.task_id));
    for(const task of allTasks)if(task.contact_id!==null&&pairs.has(pair(task.run_id,task.contact_id)))taskIds.add(String(task.id));
  }
  // 清理中引用会逐步移除；原计划继续固定原任务，不以消失的引用缩窄已接受闭包。
  for(const target of oldTargets(tx,op).values())if(target.rowKind==='processing_task')taskIds.add(target.key.id);
  const tasks=allTasks.filter(t=>taskIds.has(String(t.id)));
  const steps=tx.all('SELECT * FROM processing_step WHERE owner_id=? ORDER BY id',[ownerId]).filter(s=>taskIds.has(String(s.task_id)));
  const stepIds=new Set(steps.map(s=>String(s.id)));
  const attempts=tx.all('SELECT * FROM step_attempt WHERE owner_id=? ORDER BY id',[ownerId]).filter(a=>stepIds.has(String(a.step_id)));
  const attemptIds=new Set(attempts.map(a=>String(a.id)));
  const events=tx.all('SELECT * FROM execution_event WHERE owner_id=? ORDER BY id',[ownerId]).filter(e=>attemptIds.has(String(e.step_attempt_id)));
  const ledgerScope=new Set<string>();
  if(scope.kind==='account')for(const o of tx.all('SELECT id FROM model_operation WHERE owner_id=?',[ownerId]))ledgerScope.add(String(o.id));
  else if(eraseLedger(op)&&'contactId'in scope)for(const o of tx.all('SELECT operation_id FROM operation_scope WHERE owner_id=? AND source_contact_id=?',[ownerId,scope.contactId]))ledgerScope.add(String(o.operation_id));
  for(const target of oldTargets(tx,op).values())if(target.rowKind==='model_operation')ledgerScope.add(target.key.id);
  // 共用调用表还承载讨论生产者；本领域只拥有提取／核验分支及其封存记录。
  const operations=tx.all("SELECT * FROM model_operation WHERE owner_id=? AND purpose IN ('extraction','verification') AND reply_request_id IS NULL ORDER BY id",[ownerId])
    .filter(o=>stepIds.has(String(o.memory_step_id))||ledgerScope.has(String(o.id)));
  for(const task of tasks)if(task.contact_id!==null)pairs.add(pair(task.run_id,task.contact_id));
  const contacts=allContacts.filter(c=>pairs.has(pair(c.run_id,c.contact_id)));
  const inputs=tx.all('SELECT * FROM run_input WHERE owner_id=? ORDER BY run_id,input_no',[ownerId])
    .filter(i=>pairs.has(pair(i.run_id,i.source_contact_id)));
  const itemIds=new Set(inputs.filter(i=>i.item_id!==null).map(i=>String(i.item_id)));
  const items=tx.all('SELECT * FROM processing_item WHERE owner_id=? ORDER BY id',[ownerId]).filter(i=>
    scope.kind==='account'||eraseLedger(op)&&'contactId'in scope&&i.contact_id===scope.contactId||itemIds.has(String(i.id)));
  const affectedRuns=new Set(tasks.map(t=>String(t.run_id)));
  const runs=tx.all('SELECT * FROM processing_run WHERE owner_id=? ORDER BY id',[ownerId]).filter(r=>scope.kind==='account'
    ||affectedRuns.has(String(r.id))&&!allTasks.some(t=>t.run_id===r.id&&!taskIds.has(String(t.id))));
  return {tasks,steps,attempts,events,operations,inputs,contacts,items,runs};
}
function collect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[] {
  if(!allowed(op))return [];
  fenced(tx,op);const c=closure(tx,op),old=oldTargets(tx,op);
  const holders=c.tasks.map(t=>`memory:${t.id}`).sort(),targets:RowDeletionTarget[]=[];
  const add=(kind:string,row:StorageRow)=>{
    const key=Object.fromEntries(rowKinds[kind].keys.map(k=>[k,String(row[k])])),identity=address(kind,key);
    targets.push(old.get(identity)??{kind:'row',domain,rowKind:kind,key,identity,holderKeys:holders});
  };
  const events=new Set(c.events.map(e=>String(e.id)));
  for(const kind of ['execution_reuse','event_source','execution_input'])
    for(const row of tx.all(`SELECT * FROM ${kind} WHERE owner_id=?`,[op.ownerId]))if(events.has(String(row.event_id)))add(kind,row);
  c.events.forEach(r=>add('execution_event',r));
  const steps=new Set(c.steps.map(s=>String(s.id)));
  for(const row of tx.all('SELECT * FROM step_input WHERE owner_id=?',[op.ownerId]))if(steps.has(String(row.step_id)))add('step_input',row);
  const operations=new Set(c.operations.map(o=>String(o.id)));
  for(const row of tx.all('SELECT * FROM model_call WHERE owner_id=?',[op.ownerId]))if(operations.has(String(row.operation_id))
    &&(eraseLedger(op)||row.step_attempt_id!==null))add('model_call',row);
  for(const row of tx.all('SELECT * FROM operation_item WHERE owner_id=?',[op.ownerId]))if(operations.has(String(row.operation_id)))add('operation_item',row);
  if(eraseLedger(op))for(const row of tx.all('SELECT * FROM operation_scope WHERE owner_id=?',[op.ownerId]))if(operations.has(String(row.operation_id)))add('operation_scope',row);
  c.operations.filter(o=>eraseLedger(op)||o.memory_step_id!==null).forEach(r=>add('model_operation',r));
  c.attempts.forEach(r=>add('step_attempt',r));c.steps.forEach(r=>add('processing_step',r));
  const tasks=new Set(c.tasks.map(t=>String(t.id)));
  for(const row of tx.all('SELECT * FROM task_contribution WHERE owner_id=?',[op.ownerId]))if(tasks.has(String(row.task_id)))add('task_contribution',row);
  c.tasks.forEach(r=>add('processing_task',r));c.inputs.forEach(r=>add('run_input',r));c.contacts.forEach(r=>add('run_contact',r));
  c.items.filter(i=>eraseLedger(op)||i.message_id!==null).forEach(r=>add('processing_item',r));
  c.runs.forEach(r=>add('processing_run',r));return targets;
}
function receiptSummary(raw:unknown):string|null {
  if(raw===null)return null;
  let receipt:Record<string,unknown>;try{receipt=JSON.parse(String(raw));}catch{return null;}
  const scalar=['attempt_id','permit_id','request_id','owner_id','contact_id','scope_kind','provider','model','called_at','latency_ms','dispatch','outcome'];
  const result=Object.fromEntries(scalar.filter(k=>receipt[k]===null||typeof receipt[k]==='string'||typeof receipt[k]==='number').map(k=>[k,receipt[k]]));
  const usage=receipt.usage;
  if(usage&&typeof usage==='object'&&!Array.isArray(usage))result.usage=Object.fromEntries(['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens']
    .filter(k=>(usage as Record<string,unknown>)[k]===null||typeof (usage as Record<string,unknown>)[k]==='number').map(k=>[k,(usage as Record<string,unknown>)[k]]));
  return JSON.stringify(result);
}

export const memoryExtractionDeletionDomain:DeletionDomain={
  id:domain,rowKinds,
  fence(tx,op){
    if(!allowed(op))return [];
    fenced(tx,op);const c=closure(tx,op),now=Date.now();
    for(const task of c.tasks)tx.run("UPDATE processing_task SET state='revoked',control_revision=control_revision+1,error_code='source_deleted' WHERE owner_id=? AND id=? AND state<>'revoked'",[op.ownerId,task.id]);
    for(const step of c.steps)tx.run("UPDATE processing_step SET state='revoked',successful_attempt_id=NULL WHERE owner_id=? AND id=?",[op.ownerId,step.id]);
    for(const attempt of c.attempts)tx.run("UPDATE step_attempt SET state='aborted',finished_at=?,error_code='source_deleted' WHERE owner_id=? AND id=? AND state='running'",[now,op.ownerId,attempt.id]);
    for(const item of c.items)tx.run("UPDATE processing_item SET extraction_state='invalidated' WHERE owner_id=? AND id=? AND extraction_state NOT IN ('invalidated','deleted')",[op.ownerId,item.id]);
    for(const operation of c.operations)tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=COALESCE(commit_forbidden_at,?),input_seal='deleted' WHERE owner_id=? AND id=?",[now,op.ownerId,operation.id]);
    const affectedRuns=new Set(c.tasks.map(t=>String(t.run_id))),wholeRuns=new Set(c.runs.map(r=>String(r.id)));
    for(const runId of affectedRuns)tx.run('UPDATE processing_run SET state=? WHERE owner_id=? AND id=?',[wholeRuns.has(runId)?'revoked':'incomplete',op.ownerId,runId]);
    const requests=tx.all('SELECT start_request_key,id FROM processing_run WHERE owner_id=?',[op.ownerId])
      .filter(r=>op.scope.kind==='account'||affectedRuns.has(String(r.id)));
    return requests.map(r=>({namespace:'memoryExtraction.start',key:String(r.start_request_key)}));
  },
  collect,
  clearRow(tx,op,target){
    if(!allowed(op)||target.domain!==domain||!Object.hasOwn(rowKinds,target.rowKind)||target.key.owner_id!==op.ownerId
      ||Object.keys(target.key).sort().join()!==[...rowKinds[target.rowKind].keys].sort().join()
      ||target.identity!==address(target.rowKind,target.key))fail('memory_deletion_target_invalid');
    fenced(tx,op);
    if(!tx.get('SELECT 1 FROM deletion_target WHERE operation_id=? AND domain=? AND row_kind=? AND expected_identity=? AND target_payload IS NOT NULL',
      [op.operationId,domain,target.rowKind,JSON.stringify(target.identity)]))fail('memory_deletion_target_unplanned');
    const keys=rowKinds[target.rowKind].keys,where=keys.map(k=>`${k}=?`).join(' AND '),args=keys.map(k=>target.key[k]);
    if(target.rowKind==='model_call'&&!eraseLedger(op)){
      const call=tx.get(`SELECT receipt FROM model_call WHERE ${where}`,args);
      if(call)tx.run(`UPDATE model_call SET step_attempt_id=NULL,receipt=? WHERE ${where}`,[receiptSummary(call.receipt),...args]);
    }else if(target.rowKind==='model_operation'&&!eraseLedger(op)){
      tx.run(`UPDATE model_operation SET memory_step_id=NULL,state='sealed',input_seal='deleted' WHERE ${where}`,args);
    }else if(target.rowKind==='processing_item'&&!eraseLedger(op)){
      const item=tx.get(`SELECT * FROM processing_item WHERE ${where}`,args);if(!item)return;
      const preserved=tx.get("SELECT 1 FROM capture_record WHERE owner_id=? AND contact_id=? AND message_id=? AND availability='available' AND state='normalized'",[op.ownerId,item.contact_id,item.message_id]);
      if(preserved)tx.run(`UPDATE processing_item SET extraction_state='invalidated' WHERE ${where}`,args);
      else tx.run(`UPDATE processing_item SET message_id=NULL,extraction_state='deleted',pipeline_state='deleted' WHERE ${where}`,args);
    }else tx.run(`DELETE FROM ${target.rowKind} WHERE ${where}`,args);
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
      scope_suppression:identityDeletionAuthority.verify(tx,op).result==='passed'?pass('memory_identity_fence_current'):{result:'blocked',proof:'memory_identity_fence_missing'}};
  },
};
