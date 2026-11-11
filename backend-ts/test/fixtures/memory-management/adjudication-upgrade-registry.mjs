import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {registry as shared} from '../memory-sqlite/shared-producer-registry.mjs';
import {memoryAdjudicationMigration} from '../../../src/memory/sqlite/management/adjudication-schema.ts';
import {legacyHistorySeed,legacyCandidateSeed,legacyWithdraw} from './adjudication-legacy-seed.mjs';
const params=new URL(import.meta.url).searchParams,phase=params.get('fail'),mode=params.get('mode');
// 故障仅限可信fixture，记录当前连接关闭事实，不向生产Worker增加控制接口。
if(mode==='restoreFailure'){
 const exec=DatabaseSync.prototype.exec,close=DatabaseSync.prototype.close;
 let disabled=false;
 DatabaseSync.prototype.exec=function(sql){if(sql==='PRAGMA foreign_keys=OFF')disabled=true;if(disabled&&sql==='PRAGMA foreign_keys=ON')throw new StorageFailure('synthetic_restore_failure');return exec.call(this,sql);};
 DatabaseSync.prototype.close=function(){if(disabled)writeFileSync(params.get('proof'),JSON.stringify({closed:true,foreignKeys:Number(this.prepare('PRAGMA foreign_keys').get().foreign_keys),transaction:this.isTransaction}));return close.call(this);};
}
const oldColumns={processing_step:'owner_id,id,task_id,step_no,kind,state,input_state,successful_attempt_id',model_operation:'owner_id,id,purpose,memory_step_id,slot,input_seal,state,commit_forbidden_at,reply_request_id',step_input:'owner_id,step_id,input_no,run_id,run_input_no'};
const inspect={name:'fixture.upgradeInspect',mode:'read',retryBusy:false,execute(tx){
 const tables=tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('database_instance','schema_migration') ORDER BY name");
 return {data:Object.fromEntries(tables.map(({name})=>[name,tx.all(`SELECT ${oldColumns[name]??'*'} FROM ${name}`)])),
 catalog:tx.all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('index','trigger') AND name NOT GLOB 'sqlite_*' ORDER BY type,name"),
 ledger:tx.all('SELECT * FROM schema_migration ORDER BY version'),fk:tx.get('PRAGMA foreign_keys').foreign_keys,userVersion:tx.get('PRAGMA user_version').user_version,
 instance:tx.get('SELECT * FROM database_instance'),stepColumns:tx.all('PRAGMA table_info(processing_step)'),inputColumns:tx.all('PRAGMA table_info(step_input)')};
}};
const extra={name:'fixture.upgradeLegacy',mode:'write',retryBusy:false,execute(tx,{owner,m}){
 const call=randomUUID(),sealed=randomUUID();
 tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,step_attempt_id,provider,request_key,state,reserved_budget_units,settlement_state) VALUES(?,?,?,2,?,'synthetic',?,'unknown',17,'unknown')",[owner,call,m.operation,m.attempt,randomUUID()]);
 tx.run("INSERT INTO operation_item VALUES(?,?,?,'extraction','unknown')",[owner,m.operation,m.item]);
 tx.run("INSERT INTO model_operation(owner_id,id,purpose,slot,input_seal,state,commit_forbidden_at) VALUES(?,?,'verification',9,'old-sealed-input','sealed',1)",[owner,sealed]);
 return {call,sealed};
}};
const typed={name:'fixture.typedAdjudication',mode:'write',retryBusy:false,execute(tx,i){
 const {owner,candidateId,memoryId,messages=[],kind='adjudication',violation}=i;
 const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[owner,candidateId]);
 const original=tx.get('SELECT t.* FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE c.owner_id=? AND c.id=?',[owner,candidateId]);
 let task=original.id;
 if(i.onlyContact){
  const run=randomUUID();task=randomUUID();
  tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'preparing',1,0,'{}')",[owner,run,randomUUID()]);
  tx.run('INSERT INTO run_contact SELECT owner_id,?,contact_id,grant_id,binding_id,accepted_selection_generation,accepted_data_generation,accepted_identity_generation,accepted_account_revision,accepted_source_generation,accepted_feedback_revision,state FROM run_contact WHERE owner_id=? AND run_id=? AND contact_id=?',[run,owner,original.run_id,i.onlyContact]);
  tx.run("UPDATE processing_run SET state='running' WHERE owner_id=? AND id=?",[owner,run]);
  tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,state) VALUES(?,?,?,'self','running')",[owner,task,run]);
  tx.run('INSERT INTO task_contribution VALUES(?,?,?,?)',[owner,task,run,i.onlyContact]);
 }
 const step=randomUUID(),attempt=randomUUID(),operation=randomUUID(),call=randomUUID(),event=randomUUID();
 const n=tx.get('SELECT COALESCE(MAX(step_no),0)+1 n FROM processing_step WHERE owner_id=? AND task_id=?',[owner,task]).n;
 const revision=tx.get("SELECT CASE WHEN t.scope_kind='self' THEN o.memory_revision ELSE p.memory_revision END r FROM processing_task t JOIN owner o ON o.owner_id=t.owner_id LEFT JOIN contact p ON p.owner_id=t.owner_id AND p.id=t.contact_id WHERE t.owner_id=? AND t.id=?",[owner,task]).r;
 tx.run("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,successful_attempt_id,accepted_memory_revision) VALUES(?,?,?,?,?,'running','frozen',NULL,?)",[owner,step,task,n,kind,violation==='missing_step_revision'?null:revision]);
 let input=0;
 if(!i.skipCandidate)tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,candidate_id,accepted_state_revision) VALUES(?,?,?,'candidate',?,?)",[owner,step,++input,i.otherCandidateId??candidateId,violation==='null_candidate_revision'?null:c.state_revision]);
 for(const memoryId of i.memoryIds??(i.memoryId?[i.memoryId]:[])){const m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,memoryId]);tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,memory_id,memory_version_no,accepted_head_revision) VALUES(?,?,?,'memory',?,?,?)",[owner,step,++input,memoryId,violation==='wrong_memory_version'?999:m.current_version_no,violation==='null_head_revision'?null:m.head_revision]);}
 for(const m of messages)tx.run("INSERT INTO step_input(owner_id,step_id,input_no,kind,source_contact_id,message_id,record_id,accepted_revision) VALUES(?,?,?,'message',?,?,?,?)",[owner,step,++input,m.contactId,m.messageId,violation==='wrong_record'?randomUUID():m.recordId,violation==='null_message_revision'?null:BigInt(m.acceptedRevision)]);
 if(violation==='frozen_revision')tx.run('UPDATE processing_step SET accepted_memory_revision=accepted_memory_revision+1 WHERE owner_id=? AND id=?',[owner,step]);
 tx.run("INSERT INTO step_attempt VALUES(?,?,?,1,0,'synthetic',9999999999999,0,'synthetic','running',1,NULL,NULL)",[owner,attempt,step]);
 tx.run("INSERT INTO model_operation(owner_id,id,purpose,memory_step_id,slot,input_seal,state) VALUES(?,?,?,?,0,'typed-synthetic','resolved')",[owner,operation,violation==='wrong_purpose'?'discussion':violation==='new_purpose_wrong_step'?'merge_verification':kind,step]);
 tx.run("INSERT INTO model_call(owner_id,id,operation_id,attempt_no,step_attempt_id,provider,request_key,state,reserved_budget_units,settlement_state) VALUES(?,?,?,1,?,'synthetic',?,'succeeded',1,'settled')",[owner,call,operation,attempt,randomUUID()]);
 tx.run("INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,originated_call_id,payload,created_at) VALUES(?,?,?,1,'model_output',?,'{}',1)",[owner,event,attempt,call]);
 for(let no=1;no<=input;no++)tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,'context',?,?,?)",[owner,event,no,no,step,no]);
 for(const m of messages)tx.run('INSERT INTO event_source VALUES(?,?,?,?)',[owner,event,m.contactId,m.recordId]);
 return {step,attempt,operation,call,event,kind:tx.get('SELECT kind,accepted_memory_revision FROM processing_step WHERE owner_id=? AND id=?',[owner,step]),inputs:tx.all('SELECT * FROM step_input WHERE owner_id=? AND step_id=? ORDER BY input_no',[owner,step]),contributors:tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[owner,task])};
}};
const publish={name:'fixture.typedPublish',mode:'write',retryBusy:false,execute(tx,{owner,candidateId,execution}){
 const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[owner,candidateId]),memory=randomUUID(),decision=randomUUID();
 tx.run("UPDATE step_attempt SET state='succeeded',finished_at=1 WHERE owner_id=? AND id=?",[owner,execution.attempt]);
 tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[execution.attempt,owner,execution.step]);
 tx.run("INSERT INTO memory(owner_id,id,scope_kind,contact_id,state) VALUES(?,?,?,?,'withdrawn')",[owner,memory,c.scope_kind,c.contact_id]);
 tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,execution_id,target_memory_id,created_at,outcome) VALUES(?,?,?,'auto_accept','system',?,?,1,'applied')",[owner,decision,randomUUID(),execution.attempt,memory]);
 tx.run("INSERT INTO decision_candidate VALUES(?,?,?,'accepted',?)",[owner,decision,candidateId,c.state_revision]);
 tx.run("INSERT INTO memory_version VALUES(?,?,1,?,'adoption','auto',?,NULL,NULL,0,'present','eligible')",[owner,memory,c.proposed_body,decision]);
 for(const r of tx.all('SELECT * FROM memory_required_message WHERE owner_id=? AND candidate_id=?',[owner,candidateId]))tx.run('INSERT INTO memory_required_message VALUES(?,?,NULL,?,1,?,?)',[owner,randomUUID(),memory,r.source_contact_id,r.message_id]);
 for(const r of tx.all('SELECT * FROM memory_citation WHERE owner_id=? AND candidate_id=?',[owner,candidateId]))tx.run('INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation) VALUES(?,?,NULL,?,1,?,?,?,?,?,?,?)',[owner,randomUUID(),memory,r.source_contact_id,r.message_id,r.record_id,r.accepted_revision,r.span_start,r.span_end,r.explanation]);
 tx.run("UPDATE memory SET current_version_no=1,head_revision=1,state='active' WHERE owner_id=? AND id=?",[owner,memory]);
 tx.run("UPDATE memory_candidate SET state='adopted',state_revision=state_revision+1 WHERE owner_id=? AND id=?",[owner,candidateId]);
 tx.run('UPDATE owner SET memory_revision=memory_revision+1 WHERE owner_id=?',[owner]);
 return {memoryId:memory,decisionId:decision};
}};
const hold={name:'fixture.upgradeHoldRead',mode:'read',retryBusy:false,execute(tx,{gate}){
 const before=tx.get('SELECT COUNT(*) n FROM model_call').n,barrier=new Int32Array(gate);
 Atomics.store(barrier,0,1);Atomics.notify(barrier,0);
 if(Atomics.wait(barrier,1,0,5000)==='timed-out')throw new Error('synthetic_read_wait_timeout');
 return {before};
}};
const formal={name:'fixture.upgradeFormalHistory',mode:'write',retryBusy:false,execute(tx,{owner,candidateId,firstOnly=false}){
 const c=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[owner,candidateId]),memory=randomUUID(),first=randomUUID(),second=randomUUID(),protection=randomUUID();
 tx.run("INSERT INTO memory(owner_id,id,scope_kind,contact_id,state) VALUES(?,?,?,?,'withdrawn')",[owner,memory,c.scope_kind,c.contact_id]);
 tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,target_memory_id,created_at,outcome) VALUES(?,?,?,'accept','user',?,1,'applied')",[owner,first,randomUUID(),memory]);
 tx.run("INSERT INTO decision_candidate VALUES(?,?,?,'accepted',?)",[owner,first,candidateId,c.state_revision]);
 tx.run("INSERT INTO memory_version VALUES(?,?,1,?,'adoption','user',?,NULL,NULL,0,'present','eligible')",[owner,memory,c.proposed_body,first]);
 function sources(version){
  for(const r of tx.all('SELECT * FROM memory_required_message WHERE owner_id=? AND candidate_id=?',[owner,candidateId]))tx.run('INSERT INTO memory_required_message VALUES(?,?,NULL,?,?,?,?)',[owner,randomUUID(),memory,version,r.source_contact_id,r.message_id]);
  for(const r of tx.all('SELECT * FROM memory_citation WHERE owner_id=? AND candidate_id=?',[owner,candidateId]))tx.run('INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?)',[owner,randomUUID(),memory,version,r.source_contact_id,r.message_id,r.record_id,r.accepted_revision,r.span_start,r.span_end,r.explanation]);
 }
 sources(1);tx.run("UPDATE memory SET current_version_no=1,head_revision=1,state='active' WHERE owner_id=? AND id=?",[owner,memory]);
 tx.run("UPDATE memory_candidate SET state='adopted',state_revision=state_revision+1 WHERE owner_id=? AND id=?",[owner,candidateId]);
 if(firstOnly){tx.run('UPDATE owner SET memory_revision=memory_revision+1 WHERE owner_id=?',[owner]);return {memoryId:memory};}
 tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,target_memory_id,expected_version_no,expected_head_revision,created_at,outcome) VALUES(?,?,?,'correct','user',?,1,1,2,'applied')",[owner,second,randomUUID(),memory]);
 tx.run("INSERT INTO memory_version VALUES(?,?,2,'合成修正资料','correction','user',?,1,NULL,0,'present','eligible')",[owner,memory,second]);sources(2);
 tx.run('UPDATE memory SET current_version_no=2,head_revision=2 WHERE owner_id=? AND id=?',[owner,memory]);
 tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,target_memory_id,expected_version_no,expected_head_revision,created_at,outcome) VALUES(?,?,?,'protect','user',?,2,2,3,'applied')",[owner,protection,randomUUID(),memory]);
 tx.run('UPDATE memory SET head_revision=3,manual_protection=1,protection_decision_id=? WHERE owner_id=? AND id=?',[protection,owner,memory]);
 tx.run('UPDATE owner SET memory_revision=memory_revision+3 WHERE owner_id=?',[owner]);return {memoryId:memory};
}};
const retire={name:'fixture.autoRetireCase',mode:'write',retryBusy:false,execute(tx,{owner,candidateId,execution,primaryId,secondaryId,violation}){
 const candidate=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[owner,candidateId]),primary=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,primaryId]),secondary=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,secondaryId]);
 const mainDecision=randomUUID(),retirement=randomUUID(),before=tx.get('SELECT COUNT(*) n FROM memory_version WHERE owner_id=?',[owner]).n;
 if(violation!=='running'){
  tx.run("UPDATE step_attempt SET state='succeeded',finished_at=1 WHERE owner_id=? AND id=?",[owner,execution.attempt]);
  tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[execution.attempt,owner,execution.step]);
 }
 if(violation!=='missing_primary'){
  tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,execution_id,target_memory_id,expected_version_no,expected_head_revision,created_at,outcome) VALUES(?,?,?,'auto_update','system',?,?,?,?,1,'applied')",[owner,mainDecision,randomUUID(),execution.attempt,primaryId,primary.current_version_no,primary.head_revision]);
  tx.run("INSERT INTO decision_candidate VALUES(?,?,?,'accepted',?)",[owner,mainDecision,candidateId,candidate.state_revision]);
  const version=primary.current_version_no+1n;
  tx.run("INSERT INTO memory_version VALUES(?,?,?,?,'adoption','auto',?,?,NULL,0,'present','eligible')",[owner,primaryId,version,candidate.proposed_body,mainDecision,primary.current_version_no]);
  for(const r of tx.all('SELECT * FROM memory_required_message WHERE owner_id=? AND candidate_id=?',[owner,candidateId]))tx.run('INSERT INTO memory_required_message VALUES(?,?,NULL,?,?,?,?)',[owner,randomUUID(),primaryId,version,r.source_contact_id,r.message_id]);
  for(const r of tx.all('SELECT * FROM memory_citation WHERE owner_id=? AND candidate_id=?',[owner,candidateId]))tx.run('INSERT INTO memory_citation(owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?)',[owner,randomUUID(),primaryId,version,r.source_contact_id,r.message_id,r.record_id,r.accepted_revision,r.span_start,r.span_end,r.explanation]);
  tx.run('UPDATE memory SET current_version_no=?,head_revision=head_revision+1 WHERE owner_id=? AND id=?',[version,owner,primaryId]);
  tx.run("UPDATE memory_candidate SET state='adopted',state_revision=state_revision+1 WHERE owner_id=? AND id=?",[owner,candidateId]);
 }
 if(violation==='protected')tx.run('UPDATE memory SET manual_protection=1 WHERE owner_id=? AND id=?',[owner,secondaryId]);
 if(violation==='call_failed')tx.run("UPDATE model_call SET state='failed' WHERE owner_id=? AND id=?",[owner,execution.call]);
 tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,execution_id,target_memory_id,expected_version_no,expected_head_revision,restored_from_version_no,created_at,outcome) VALUES(?,?,?,'auto_retire',?,?,?,?,?,?,1,'applied')",[owner,retirement,randomUUID(),violation==='user'?'user':'system',violation==='missing_execution'?null:execution.attempt,violation==='missing_target'?null:secondaryId,violation==='missing_expected'?null:secondary.current_version_no,violation==='stale_head'?secondary.head_revision+1n:secondary.head_revision,violation==='restored'?secondary.current_version_no:null]);
 if(violation==='version')tx.run("INSERT INTO memory_version VALUES(?,?,?,'不得新增','adoption','auto',?,?,NULL,0,'present','eligible')",[owner,secondaryId,secondary.current_version_no+1n,retirement,secondary.current_version_no]);
 tx.run("UPDATE memory SET state='withdrawn',head_revision=head_revision+1 WHERE owner_id=? AND id=?",[owner,secondaryId]);
 return {retirement,mainDecision,before,after:tx.get('SELECT COUNT(*) n FROM memory_version WHERE owner_id=?',[owner]).n,retireVersions:tx.get('SELECT COUNT(*) n FROM memory_version WHERE owner_id=? AND decision_id=?',[owner,retirement]).n,retireCandidates:tx.get('SELECT COUNT(*) n FROM decision_candidate WHERE owner_id=? AND decision_id=?',[owner,retirement]).n};
}};
// 仅检验DDL约束；正常模型/解析/finish正例由正式pipeline测试单独覆盖。
const prepareNoop={name:'fixture.prepareNoopSql',mode:'write',retryBusy:false,execute(tx,i){
 const result=typed.execute(tx,i),candidate=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[i.owner,i.candidateId]),event=randomUUID();
 tx.run("UPDATE step_attempt SET state='succeeded',finished_at=1 WHERE owner_id=? AND id=?",[i.owner,result.attempt]);
 tx.run("UPDATE processing_step SET state='succeeded',successful_attempt_id=? WHERE owner_id=? AND id=?",[result.attempt,i.owner,result.step]);
 tx.run("INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,2,'adjudication_result',?,1)",[i.owner,event,result.attempt,JSON.stringify({candidateId:i.candidateId,action:'auto_noop',reason:null,parentMemoryIds:[i.memoryId],text:candidate.proposed_body})]);
 for(const input of result.inputs)tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,?,?,?,?)",[i.owner,event,input.input_no,input.kind==='memory'?'parent_memory':input.kind,input.input_no,result.step,input.input_no]);
 return {...result,resultEvent:event};
}};
const noopProbe={name:'fixture.noopSqlProbe',mode:'write',retryBusy:false,execute(tx,{owner,candidateId,memoryId,execution,mode}){
 const decision=randomUUID(),candidate=tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[owner,candidateId]),memory=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,memoryId]);
 tx.run('SAVEPOINT noop_probe');let rejected=false;
 try{
  if(mode==='missing_result'){
   tx.run('DELETE FROM execution_input WHERE owner_id=? AND event_id=?',[owner,execution.resultEvent]);tx.run('DELETE FROM execution_event WHERE owner_id=? AND id=?',[owner,execution.resultEvent]);
  }else if(['action','candidate','parent','reason'].includes(mode)){
   const event=tx.get('SELECT payload FROM execution_event WHERE owner_id=? AND id=?',[owner,execution.resultEvent]),payload=JSON.parse(event.payload);
   if(mode==='action')payload.action='auto_update';else if(mode==='candidate')payload.candidateId=randomUUID();else if(mode==='parent')payload.parentMemoryIds=[randomUUID()];else payload.reason='memory_relationship_pending';
   tx.run('UPDATE execution_event SET payload=? WHERE owner_id=? AND id=?',[JSON.stringify(payload),owner,execution.resultEvent]);
  }else if(mode==='candidate_role')tx.run("DELETE FROM execution_input WHERE owner_id=? AND event_id=? AND role='candidate'",[owner,execution.resultEvent]);
  else if(mode==='parent_role'){
   const row=tx.get("SELECT * FROM execution_input WHERE owner_id=? AND event_id=? AND role='parent_memory'",[owner,execution.resultEvent]);
   tx.run('DELETE FROM execution_input WHERE owner_id=? AND event_id=? AND input_no=?',[owner,execution.resultEvent,row.input_no]);
   tx.run("INSERT INTO execution_input(owner_id,event_id,input_no,role,presentation_no,planned_step_id,planned_input_no) VALUES(?,?,?,'comparison_memory',?,?,?)",[owner,execution.resultEvent,row.input_no,row.presentation_no,row.planned_step_id,row.planned_input_no]);
  }else if(mode==='candidate_revision')tx.run('UPDATE memory_candidate SET state_revision=state_revision+1 WHERE owner_id=? AND id=?',[owner,candidateId]);
  else if(mode==='candidate_not_pending')tx.run("UPDATE memory_candidate SET state='rejected' WHERE owner_id=? AND id=?",[owner,candidateId]);
  else if(mode==='multiple_results'){
   const payload=tx.get('SELECT payload FROM execution_event WHERE owner_id=? AND id=?',[owner,execution.resultEvent]).payload;
   tx.run("INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,3,'adjudication_result',?,1)",[owner,randomUUID(),execution.attempt,payload]);
  }else if(mode==='failed_call')tx.run("UPDATE model_call SET state='failed' WHERE owner_id=? AND id=?",[owner,execution.call]);
  else if(mode==='consume_failure')tx.run("CREATE TEMP TRIGGER noop_consume_fault BEFORE UPDATE OF state ON main.memory_candidate WHEN NEW.state='duplicate' BEGIN SELECT RAISE(ABORT,'synthetic_noop_consume_fault'); END");
  try{
   if(mode==='duplicate_without_decision')tx.run("UPDATE memory_candidate SET state='duplicate',state_revision=state_revision+1 WHERE owner_id=? AND id=?",[owner,candidateId]);
   else tx.run("INSERT INTO memory_decision(owner_id,id,request_key,action,actor_kind,execution_id,target_memory_id,expected_version_no,expected_head_revision,created_at,outcome) VALUES(?,?,?,'auto_noop','system',?,?,?,?,1,'applied')",[owner,decision,randomUUID(),execution.attempt,memoryId,memory.current_version_no,memory.head_revision]);
  }catch{rejected=true;}
  const observed={rejected,decision:tx.get('SELECT * FROM memory_decision WHERE owner_id=? AND id=?',[owner,decision]),relations:tx.all('SELECT * FROM decision_candidate WHERE owner_id=? AND decision_id=?',[owner,decision]),candidate:tx.get('SELECT * FROM memory_candidate WHERE owner_id=? AND id=?',[owner,candidateId]),memory:tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[owner,memoryId]),versions:tx.get('SELECT COUNT(*) n FROM memory_version WHERE owner_id=? AND memory_id=?',[owner,memoryId]).n};
  if(mode==='valid')tx.run('RELEASE noop_probe');else{tx.run('ROLLBACK TO noop_probe');tx.run('RELEASE noop_probe');}
  return {...observed,originalRevision:candidate.state_revision};
 }catch(error){tx.run('ROLLBACK TO noop_probe');tx.run('RELEASE noop_probe');throw error;}
}};
const noopRelation={name:'fixture.noopRelationMutation',mode:'write',retryBusy:false,execute(tx,{owner,decisionId,candidateId,mode}){
 if(mode==='update')tx.run('UPDATE decision_candidate SET accepted_state_revision=accepted_state_revision+1 WHERE owner_id=? AND decision_id=?',[owner,decisionId]);
 else if(mode==='adopt')tx.run("UPDATE memory_candidate SET state='adopted' WHERE owner_id=? AND id=?",[owner,candidateId]);
 else tx.run('DELETE FROM decision_candidate WHERE owner_id=? AND decision_id=?',[owner,decisionId]);
 return tx.get('SELECT * FROM memory_decision WHERE owner_id=? AND id=?',[owner,decisionId]);
}};
const migrate=memoryAdjudicationMigration(12);
if(mode==='unmarked')delete migrate.rebuild;
if(mode==='tamper')migrate.sql+='\nSELECT 2;';
export const registry={migrations:mode==='current'?shared.migrations:[...shared.migrations.filter(m=>m.version<=11),...(mode==='legacy'?[]:[migrate])],actions:[...shared.actions,legacyHistorySeed,legacyCandidateSeed,legacyWithdraw,inspect,extra,typed,publish,hold,formal,retire,prepareNoop,noopProbe,noopRelation],migrationObserver:phase?event=>{if(event.phase===phase)throw new Error('synthetic_upgrade_fault');}:undefined};
