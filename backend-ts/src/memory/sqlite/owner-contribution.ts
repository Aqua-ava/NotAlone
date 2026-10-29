import {randomUUID} from 'node:crypto';
import type {StorageLease,StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {assertContribution,assertInputs,currentAttempt,fail,inputRows,textId} from './qualification.ts';
interface Contribution {event:StorageRow;rows:StorageRow[]}
interface Finalization {state:'not_applicable'|'pending'|'revoked'|'succeeded'|'awaiting_decision';attemptId:string|null;outputCount:number}
const result=(state:Finalization['state'],attemptId:string|null=null,outputCount=0):Finalization=>({state,attemptId,outputCount});
function contributions(tx:StorageTransaction,ownerId:string,runId:string):Contribution[]{
 const events=tx.all(`SELECT e.*,t.contact_id FROM execution_event e
 JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
 JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 WHERE t.owner_id=? AND t.run_id=? AND t.scope_kind='contact' AND t.state='succeeded'
 AND a.state='succeeded' AND s.state='succeeded' AND s.successful_attempt_id=a.id
 AND e.kind='verified_self_contribution' ORDER BY t.contact_id,s.step_no,e.event_no`,[ownerId,runId]);
 return events.map(event=>{
  const payload=JSON.parse(String(event.payload)) as {scopeKind?:unknown;contactId?:unknown;fact?:{subject?:unknown;source_message_ids?:unknown}};
  if(payload.scopeKind!=='self'||payload.contactId!==null||payload.fact?.subject!=='self')return fail('memory_owner_contribution_invalid');
  const rows=tx.all(`SELECT i.*,x.presentation_no FROM execution_input x
 JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no
 JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
 WHERE x.owner_id=? AND x.event_id=? AND i.run_id=? ORDER BY x.presentation_no,x.input_no`,[ownerId,event.id,runId]);
  if(!rows.length||rows.some(row=>row.source_contact_id!==event.contact_id))return fail('memory_owner_contribution_incomplete');
  assertInputs(tx,ownerId,runId,rows);
  const evidence=payload.fact.source_message_ids;
  if(!Array.isArray(evidence)||!evidence.length||!evidence.every(id=>rows.some(row=>row.message_id===id))
   ||!evidence.some(id=>rows.some(row=>row.message_id===id&&row.role==='target')))return fail('memory_owner_contribution_invalid');
  const actual=tx.all('SELECT source_contact_id,record_id FROM event_source WHERE owner_id=? AND event_id=?',[ownerId,event.id]);
  const expected=new Set(rows.map(row=>JSON.stringify([row.source_contact_id,row.record_id])));
  if(actual.length!==expected.size||actual.some(row=>!expected.has(JSON.stringify([row.source_contact_id,row.record_id]))))return fail('memory_owner_contribution_incomplete');
  return {event,rows};
 });
}
/** 所有读取、本人producer、实际窗口和结果在同一短事务内闭合；没有模型或外部I/O。 */
export function finalizeOwnerContributions(tx:StorageTransaction,input:{ownerId:string;runId:string},lease:StorageLease):Finalization {
 const ownerId=textId(input.ownerId),runId=textId(input.runId);
 const task=tx.get("SELECT * FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='self'",[ownerId,runId]);
 if(!task)return result('not_applicable');
 if(task.state==='revoked')return result('revoked');
 const run=tx.get('SELECT pause_requested_at,state FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);
 if(!run||run.state==='revoked')return result('revoked');
 if(run.pause_requested_at!==null)return result('pending');
 const contactTasks=tx.all("SELECT * FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='contact'",[ownerId,runId]);
 if(!contactTasks.length||contactTasks.some(contact=>contact.state!=='succeeded'))return result('pending');
 const accepted=tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=? AND run_id=?',[ownerId,task.id,runId]);
 if(accepted.length!==contactTasks.length||contactTasks.some(contact=>!accepted.some(c=>c.source_contact_id===contact.contact_id)))return fail('memory_owner_contribution_incomplete');
 for(const contact of accepted)assertContribution(tx,ownerId,runId,String(contact.source_contact_id));
 assertInputs(tx,ownerId,runId,[]);
 const prior=tx.get("SELECT s.id,s.successful_attempt_id FROM processing_step s JOIN step_attempt a ON a.owner_id=s.owner_id AND a.id=s.successful_attempt_id WHERE s.owner_id=? AND s.task_id=? AND s.state='succeeded' AND a.state='succeeded' ORDER BY s.step_no LIMIT 1",[ownerId,task.id]);
 if(prior){
  assertInputs(tx,ownerId,runId,inputRows(tx,ownerId,String(prior.id)));
  const count=tx.get("SELECT count(*) AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind='verified_output'",[ownerId,prior.successful_attempt_id])!.n as bigint;
  if(count<0n||count>BigInt(Number.MAX_SAFE_INTEGER))return fail('memory_owner_contribution_incomplete');
  return result(count?'awaiting_decision':'succeeded',String(prior.successful_attempt_id),Number(count));
 }
 if(tx.get('SELECT 1 FROM processing_step WHERE owner_id=? AND task_id=?',[ownerId,task.id]))return fail('memory_owner_contribution_incomplete');
 const sources=contributions(tx,ownerId,runId);
 const unique=new Map<bigint,StorageRow>();
 for(const source of sources)for(const row of source.rows)unique.set(row.input_no as bigint,row);
 const frozen=[...unique.values()].sort((a,b)=>(a.input_no as bigint)<(b.input_no as bigint)?-1:1);
 const stepId=randomUUID(),attemptId=randomUUID(),now=Date.now();
 tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state) VALUES(?,?,?,1,'extraction_verification','running','frozen')",[ownerId,stepId,task.id]);
 const planned=new Map<bigint,number>();
 for(const [index,row] of frozen.entries()){
  planned.set(row.input_no as bigint,index+1);
  tx.run('INSERT INTO step_input(owner_id,step_id,input_no,run_id,run_input_no) VALUES(?,?,?,?,?)',[ownerId,stepId,index+1,runId,row.input_no]);
 }
 tx.run("INSERT INTO step_attempt(owner_id,id,step_id,attempt_no,resume_no,lease_token,lease_expires_at,accepted_control_revision,runtime_token,state,started_at) VALUES(?,?,?,1,?,?,?,?,?,'running',?)",[ownerId,attemptId,stepId,task.resume_no,randomUUID(),now+60_000,task.control_revision,lease.runtimeId,now]);
 tx.run("UPDATE processing_task SET state='running',error_code=NULL WHERE owner_id=? AND id=?",[ownerId,task.id]);
 currentAttempt(tx,ownerId,attemptId,lease);
 let eventNo=0;
 function append(kind:string,payload:string,rows:StorageRow[]):string {
  const eventId=randomUUID();
  tx.run('INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',[ownerId,eventId,attemptId,++eventNo,kind,payload,now]);
  for(const [index,row] of rows.entries()){
   const plannedNo=planned.get(row.input_no as bigint);if(plannedNo===undefined)fail('memory_owner_contribution_incomplete');
   tx.run('INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,?,?,?,?)',[ownerId,eventId,index+1,row.role,index+1,stepId,plannedNo!]);
   tx.run('INSERT OR IGNORE INTO event_source(owner_id,event_id,source_contact_id,record_id) VALUES(?,?,?,?)',[ownerId,eventId,row.source_contact_id,row.record_id]);
  }
  return eventId;
 }
 for(const source of sources){
  const eventId=append('verified_output',String(source.event.payload),source.rows);
  tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,producer_event_id) VALUES(?,?,?,'verified_contribution',?,?)",[ownerId,eventId,source.rows.length+1,source.rows.length+1,source.event.id]);
 }
 append('stage_result',JSON.stringify({outcome:sources.length?'verified_pending_decision':'no_new_memory',outputCount:sources.length,laterStages:'pending'}),frozen);
 currentAttempt(tx,ownerId,attemptId,lease);
 tx.run("UPDATE step_attempt SET state='succeeded',finished_at=? WHERE owner_id=? AND id=?",[now,ownerId,attemptId]);
 tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[attemptId,ownerId,stepId]);
 const state=sources.length?'awaiting_decision':'succeeded';
 tx.run('UPDATE processing_task SET state=?,error_code=NULL WHERE owner_id=? AND id=?',[state,ownerId,task.id]);
 return result(state,attemptId,sources.length);
}
