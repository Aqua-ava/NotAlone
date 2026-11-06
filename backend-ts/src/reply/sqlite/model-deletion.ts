import {createHash} from 'node:crypto';
import {StorageFailure,type StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {CheckResult,DeletionDomain,DeletionOperation,RowDeletionTarget} from '../../storage/sqlite/deletion/contracts.ts';
import {collectDiscussionDeletionImpact} from './deletion.ts';
import {isMediaDeletionScope} from '../../media/sqlite/deletion.ts';
const domain='discussion_calls';
const rowKinds:DeletionDomain['rowKinds']={event_source:{keys:['owner_id','event_id','record_id'],ownerKey:'owner_id'},execution_input:{keys:['owner_id','event_id','input_no'],ownerKey:'owner_id'},execution_event:{keys:['owner_id','id'],ownerKey:'owner_id'},model_call:{keys:['owner_id','id'],ownerKey:'owner_id'},operation_scope:{keys:['owner_id','operation_id','source_contact_id','effect_kind'],ownerKey:'owner_id'},model_operation:{keys:['owner_id','id'],ownerKey:'owner_id'}};
const eraseLedger=(op:DeletionOperation)=>['contact','account'].includes(op.scope.kind);
const supported=(op:DeletionOperation)=>isMediaDeletionScope(op.scope)||['discussion','source','contact_history','contact','account'].includes(op.scope.kind);
const identity=(kind:string,key:Record<string,string>)=>createHash('sha256').update(JSON.stringify([kind,Object.entries(key).sort()])).digest('hex');
const minimalReceipt='{"format":"minimal-discussion-call-v1"}';
function closure(tx:StorageTransaction,op:DeletionOperation){
 const impact=collectDiscussionDeletionImpact(tx,op),requests=new Set(impact.requestIds),attempts=new Set(impact.attemptIds),operationIds=new Set<string>();
 for(const row of tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain=? AND target_payload IS NOT NULL",[op.operationId,domain])){
  const t=JSON.parse(String(row.target_payload)) as RowDeletionTarget;
  if(t.rowKind==='model_operation')operationIds.add(t.key.id);
  if(t.rowKind==='model_call'){const c=tx.get('SELECT operation_id FROM model_call WHERE owner_id=? AND id=?',[op.ownerId,t.key.id]);if(c)operationIds.add(String(c.operation_id));}
 }
 if(eraseLedger(op))for(const s of tx.all('SELECT operation_id,source_contact_id FROM operation_scope WHERE owner_id=?',[op.ownerId]))if(op.scope.kind==='account'||'contactId'in op.scope&&s.source_contact_id===op.scope.contactId)operationIds.add(String(s.operation_id));
 const operations=tx.all("SELECT * FROM model_operation WHERE owner_id=? AND purpose='discussion'",[op.ownerId]).filter(r=>op.scope.kind==='account'||requests.has(String(r.reply_request_id))||operationIds.has(String(r.id)));
 const ids=new Set(operations.map(r=>String(r.id)));
 // 没有命中任何讨论调用/尝试时，下面的整 owner 扫描只会被空集合过滤掉，直接跳过（行集合不变）；
 // 无讨论的联系人在计划、领任务、重新收集、核验中各付一次这些扫描，真实库上合计约 2 秒。
 const calls=ids.size?tx.all('SELECT * FROM model_call WHERE owner_id=?',[op.ownerId]).filter(c=>ids.has(String(c.operation_id))):[];
 const events=attempts.size?tx.all('SELECT * FROM execution_event WHERE owner_id=?',[op.ownerId]).filter(e=>attempts.has(String(e.reply_attempt_id))):[];
 return {impact,operations,calls,events};
}
function collect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{
 if(!supported(op))return [];
 const c=closure(tx,op),targets:RowDeletionTarget[]=[];
 const add=(kind:string,row:Record<string,unknown>)=>{const key=Object.fromEntries(rowKinds[kind].keys.map(k=>[k,String(row[k])]));targets.push({kind:'row',domain,rowKind:kind,key,identity:identity(kind,key),holderKeys:c.impact.holderKeys});};
 const eventIds=new Set(c.events.map(e=>String(e.id)));
 if(eventIds.size)for(const kind of ['event_source','execution_input'])for(const row of tx.all(`SELECT * FROM ${kind} WHERE owner_id=?`,[op.ownerId]))if(eventIds.has(String(row.event_id)))add(kind,row);
 for(const row of c.events)add('execution_event',row);
 for(const row of c.calls)if(eraseLedger(op)||row.reply_attempt_id!==null||row.reply_context_id!==null||row.receipt!==minimalReceipt)add('model_call',row);
 const ids=new Set(c.operations.map(o=>String(o.id)));
 for(const s of tx.all('SELECT * FROM operation_scope WHERE owner_id=?',[op.ownerId]))if(ids.has(String(s.operation_id))&&(eraseLedger(op)||s.state!=='released'))add('operation_scope',s);
 for(const row of c.operations)if(eraseLedger(op)||row.reply_request_id!==null||row.commit_forbidden_at===null||row.input_seal!=='deleted')add('model_operation',row);
 return targets;
}
/** 只管理07共享调用表中真实discussion生产者；不另建调用/追踪或删除平台。 */
export const discussionCallDeletionDomain:DeletionDomain={
 id:domain,rowKinds,
 fence(tx,op){
  if(!supported(op))return [];
  for(const c of closure(tx,op).calls)if(c.state==='sending')tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND id=?",[op.ownerId,c.id]);
  for(const o of closure(tx,op).operations)tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=COALESCE(commit_forbidden_at,?),input_seal='deleted' WHERE owner_id=? AND id=?",[Date.now(),op.ownerId,o.id]);
  return [];
 },collect,
 clearRow(tx,op,target){
  if(target.domain!==domain||target.key.owner_id!==op.ownerId||!rowKinds[target.rowKind]||target.identity!==identity(target.rowKind,target.key))throw new StorageFailure('discussion_call_deletion_invalid');
  const row=collect(tx,op).find(t=>t.rowKind===target.rowKind&&t.identity===target.identity);if(!row)return;
  const keys=rowKinds[row.rowKind].keys,args=keys.map(k=>row.key[k]),where=keys.map(k=>`${k}=?`).join(' AND ');
  if(!eraseLedger(op)&&row.rowKind==='model_call')tx.run(`UPDATE model_call SET reply_attempt_id=NULL,reply_context_id=NULL,receipt=? WHERE ${where}`,[minimalReceipt,...args]);
  else if(!eraseLedger(op)&&row.rowKind==='model_operation')tx.run(`UPDATE model_operation SET reply_request_id=NULL,state='sealed',input_seal='deleted' WHERE ${where}`,args);
  else if(!eraseLedger(op)&&row.rowKind==='operation_scope')tx.run(`UPDATE operation_scope SET state='released' WHERE ${where}`,args);
  else tx.run(`DELETE FROM ${row.rowKind} WHERE ${where}`,args);
 },
 authorizeFile(){throw new StorageFailure('discussion_call_has_no_files');},fileCleared(){throw new StorageFailure('discussion_call_has_no_files');},
 verify(tx,op){
  const check:CheckResult=!supported(op)?{result:'not_applicable',proof:'discussion_call_scope_not_owned'}:collect(tx,op).length?{result:'blocked',proof:'discussion_call_payloads_remain'}:{result:'passed',proof:'discussion_call_payloads_cleared'};
  return {database_rows:check,derived_eligibility:check,trace_payloads:check,request_replay:check,scope_suppression:{result:'not_applicable',proof:'discussion_calls_do_not_authorize_chat_reading'}};
 },
};
