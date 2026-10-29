import {randomUUID} from 'node:crypto';
import type {StorageAction,StorageTransaction,StorageRow} from '../../storage/sqlite/contracts.ts';
import {assertContribution,assertInputs,assertTaskContributions,fail,textId} from './qualification.ts';
const number=(v:unknown):number=>{if(typeof v!=='bigint'||v<0n||v>BigInt(Number.MAX_SAFE_INTEGER))return fail('memory_extraction_count_invalid');return Number(v);};
export function snapshot(tx:StorageTransaction,ownerId:string,runId:string){
 const r=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);if(!r)fail('memory_extraction_not_found');
 const inputs=tx.all('SELECT * FROM run_input WHERE owner_id=? AND run_id=? ORDER BY input_no',[ownerId,runId]);
 const targets=inputs.filter(i=>i.role==='target');
 const tasks=tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[ownerId,runId]);
 const taskStates=new Map<string,string>();
 for(const task of tasks){let state=String(task.state);try{assertTaskContributions(tx,ownerId,runId,String(task.id));}catch{state='revoked';}taskStates.set(String(task.id),state);}
 const targetStates=new Map<string,Set<string>>();
 for(const row of tx.all(`SELECT si.run_input_no,s.state FROM step_input si JOIN processing_step s ON s.owner_id=si.owner_id AND s.id=si.step_id
 JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
 WHERE si.owner_id=? AND si.run_id=? AND s.kind='extraction_verification' AND t.scope_kind='contact' AND t.contact_id=i.source_contact_id`,[ownerId,runId])){
  const key=String(row.run_input_no),states=targetStates.get(key)??new Set<string>();states.add(String(row.state));targetStates.set(key,states);
 }
 const targetHasState=(i:StorageRow,state:string)=>targetStates.get(String(i.input_no))?.has(state)??false;
 const targetSucceeded=(i:StorageRow)=>targetHasState(i,'succeeded');
 const succeeded=targets.filter(targetSucceeded).length;
 const candidates=tx.all(`SELECT e.*,t.id AS task_id,t.scope_kind,t.contact_id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? AND e.kind='verified_output' AND t.state<>'revoked' ORDER BY e.created_at,e.event_no`,[ownerId,runId]).flatMap(e=>{
  if(taskStates.get(String(e.task_id))==='revoked')return [];
  try{const deps=tx.all(`SELECT i.* FROM execution_input x JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no WHERE x.owner_id=? AND x.event_id=?`,[ownerId,e.id]);assertInputs(tx,ownerId,runId,deps);}catch{return [];}
  const p=JSON.parse(String(e.payload));return [{id:String(e.id),attemptId:String(e.step_attempt_id),outputNo:number(e.event_no),scopeKind:p.scopeKind,contactId:p.contactId,body:p.fact.text,fact:p.fact,state:'verified_pending_decision',origin:'auto'}];
 });
 return {runId,state:String(r!.state),total:targets.length,succeeded,failed:targets.filter(i=>!targetSucceeded(i)&&targetHasState(i,'failed')).length,unknown:targets.filter(i=>!targetSucceeded(i)&&targetHasState(i,'unknown')).length,
  stage:r!.state==='completed'?'completed':'extraction_verification',laterStages:r!.state==='completed'?'completed':'pending',tasks:tasks.map(t=>({taskId:String(t.id),scopeKind:String(t.scope_kind),contactId:t.contact_id===null?null:String(t.contact_id),state:taskStates.get(String(t.id))!,
   total:t.scope_kind==='self'?0:targets.filter(i=>i.source_contact_id===t.contact_id).length,succeeded:t.scope_kind==='self'?0:targets.filter(i=>i.source_contact_id===t.contact_id&&targetSucceeded(i)).length,errorCode:t.error_code===null?null:String(t.error_code)})),
  inputs:inputs.map(i=>({inputNo:number(i.input_no),role:String(i.role),contactId:String(i.source_contact_id),messageId:String(i.message_id),recordId:String(i.record_id),itemId:i.item_id===null?null:String(i.item_id)})),candidates};
}
export const runActions:StorageAction[]=[{name:'memoryExtraction.findRequest',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;requestKey:string};const r=tx.get('SELECT id FROM processing_run WHERE owner_id=? AND start_request_key=?',[textId(i.ownerId),textId(i.requestKey)]);return r?snapshot(tx,i.ownerId,String(r.id)):null;}},{name:'memoryExtraction.contactGeneration',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;contactId:string};const r=tx.get('SELECT data_generation FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId]);if(!r)fail('memory_extraction_scope_stale');return {generation:String(r!.data_generation)};}},{name:'memoryExtraction.start',mode:'write',retryBusy:true,execute(tx,raw){
 const i=raw as {ownerId:string;requestKey:string;policyConfig:unknown};const ownerId=textId(i.ownerId),requestKey=textId(i.requestKey);
 const existing=tx.get('SELECT id FROM processing_run WHERE owner_id=? AND start_request_key=?',[ownerId,requestKey]);if(existing)return snapshot(tx,ownerId,String(existing.id));
 const owner=tx.get("SELECT * FROM owner WHERE owner_id=? AND state='active'",[ownerId]);if(!owner)fail('memory_extraction_scope_stale');
 if(tx.get('SELECT 1 FROM request_tombstone WHERE owner_identity=? AND request_key=?',[ownerId,requestKey]))fail('memory_extraction_request_deleted');
 const runId=randomUUID();tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'preparing',?,?,?)",[ownerId,runId,requestKey,Date.now(),owner!.feedback_revision,JSON.stringify(i.policyConfig)]);
 const contacts=tx.all(`SELECT c.*,g.id AS grant_id,g.binding_id,b.identity_generation,a.scope_revision,a.source_generation
 FROM contact c JOIN read_grant g ON g.owner_id=c.owner_id AND g.contact_id=c.id AND g.revoked_at IS NULL
 JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
 JOIN channel_conversation cv ON cv.owner_id=b.owner_id AND cv.id=b.conversation_id
 JOIN channel_account a ON a.owner_id=cv.owner_id AND a.id=cv.account_id
 WHERE c.owner_id=? AND c.state='active' AND b.state='verified' AND a.identity_state='verified' ORDER BY c.id`,[ownerId]);
 let inputNo=0;const contributing:string[]=[];
 for(const c of contacts){
  const rows=tx.all(`SELECT m.*,r.id AS record_id,p.id AS item_id,p.extraction_state FROM message m
 JOIN capture_record r ON r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND r.state='normalized' AND r.availability='available'
 LEFT JOIN processing_item p ON p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.message_id=m.id AND p.purpose='memory_extraction'
 WHERE m.owner_id=? AND m.contact_id=? AND m.kind='text' AND length(trim(m.text_body))>0 AND m.availability='available'
 AND r.id=(SELECT min(rr.id) FROM capture_record rr WHERE rr.owner_id=m.owner_id AND rr.message_id=m.id AND rr.state='normalized' AND rr.availability='available') ORDER BY m.display_no`,[ownerId,c.id]);
  const targets=rows.filter(r=>r.extraction_state!=='succeeded');if(!targets.length)continue;
  tx.run('INSERT INTO run_contact VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[ownerId,runId,c.id,c.grant_id,c.binding_id,c.selection_generation,c.data_generation,c.identity_generation,c.scope_revision,c.source_generation,c.feedback_revision,'active']);
  assertContribution(tx,ownerId,runId,String(c.id));contributing.push(String(c.id));
  const context=rows.filter(r=>r.extraction_state==='succeeded').slice(-8); // 有界前文也在点击事务内冻结。
  for(const m of [...context,...targets]){
   const isTarget=m.extraction_state!=='succeeded';let itemId=isTarget?m.item_id:null;
   if(isTarget&&!itemId){itemId=randomUUID();tx.run("INSERT INTO processing_item VALUES(?,?,?,?,'memory_extraction','pending','pending',NULL)",[ownerId,itemId,c.id,m.id]);}
   tx.run("INSERT INTO run_input VALUES(?,?,?,?,'message',?,?,?,?,?)",[ownerId,runId,++inputNo,isTarget?'target':'context',c.id,itemId,m.id,m.record_id,m.interpretation_revision]);
  }
  const taskId=randomUUID();tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,contact_id,state) VALUES(?,?,?,'contact',?,'pending')",[ownerId,taskId,runId,c.id]);
  tx.run('INSERT INTO task_contribution VALUES(?,?,?,?)',[ownerId,taskId,runId,c.id]);
 }
 if(contributing.length){const self=randomUUID();tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,state) VALUES(?,?,?,'self','pending')",[ownerId,self,runId]);for(const c of contributing)tx.run('INSERT INTO task_contribution VALUES(?,?,?,?)',[ownerId,self,runId,c]);}
 tx.run("UPDATE processing_run SET state='pending' WHERE owner_id=? AND id=?",[ownerId,runId]);return snapshot(tx,ownerId,runId);
}},{name:'memoryExtraction.read',mode:'read',retryBusy:false,execute(tx,raw){const i=raw as {ownerId:string;runId?:string};const owner=textId(i.ownerId);if(i.runId)return snapshot(tx,owner,textId(i.runId));const r=tx.get('SELECT id FROM processing_run WHERE owner_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1',[owner]);return r?snapshot(tx,owner,String(r.id)):null;}}];
