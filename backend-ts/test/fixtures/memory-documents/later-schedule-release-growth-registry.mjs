import {randomUUID} from 'node:crypto';
import {registry as base} from './later-schedule-registry.mjs';
import {queueSummary} from '../../../src/memory/sqlite/documents/later-schedule.ts';

export const registry={...base,actions:[...base.actions,
 {name:'fixture.laterReleaseSeed',mode:'write',retryBusy:false,execute(tx,input){
  const ownerId=String(input.ownerId),runId=randomUUID(),tasks=[];
  const contacts=Number(input.contacts);
  if(!Number.isSafeInteger(contacts)||contacts<1||contacts>200)throw Error('合成联系人数量无效');
  tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,0)',[ownerId]);
  tx.run("INSERT INTO processing_run(owner_id,id,start_request_key,state,pause_requested_at,started_at,accepted_owner_feedback_revision,policy_config) VALUES(?,?,?,'failed',1,0,0,'{}')",[ownerId,runId,randomUUID()]);
  const seedScope=(scopeKind,contactId)=>{
   const taskId=randomUUID();tasks.push(taskId);
   tx.run("INSERT INTO processing_task(owner_id,id,run_id,scope_kind,contact_id,state) VALUES(?,?,?,?,?,'failed')",[ownerId,taskId,runId,scopeKind,contactId]);
   tx.run("INSERT INTO memory_document_later_schedule(owner_id,scope_kind,scope_key,contact_id,generation,stage,state,first_changed_at,last_changed_at,due_at,requested_memory_revision) VALUES(?,?,?,?,1,'document_scene','scheduled',0,0,123,0)",[ownerId,scopeKind,contactId??'self',contactId]);
  };
  for(let index=0;index<contacts;index++){
   const contactId=randomUUID();tx.run("INSERT INTO contact(owner_id,id,state) VALUES(?,?,'active')",[ownerId,contactId]);seedScope('contact',contactId);
  }
  seedScope('self',null);
  return {runId,taskId:tasks[0]};
 }},
 {name:'fixture.laterReleaseState',mode:'write',retryBusy:false,execute(tx,input){
  if(input.taskState!==undefined){
   if(!['failed','unknown'].includes(input.taskState))throw Error('合成任务状态无效');
   tx.run('UPDATE processing_task SET state=? WHERE owner_id=? AND id=?',[input.taskState,input.ownerId,input.taskId]);
  }
  if(input.runState!==undefined){
   if(!['failed','paused'].includes(input.runState))throw Error('合成运行状态无效');
   tx.run('UPDATE processing_run SET state=? WHERE owner_id=? AND id=?',[input.runState,input.ownerId,input.runId]);
  }
  return true;
 }},
 {name:'fixture.laterReleaseQueue',mode:'read',retryBusy:false,execute(tx,input){
  let queries=0,releaseQualificationQueries=0,embeddedReleaseQualificationQueries=0;
  const observe=sql=>{
   queries++;
   // 完整退休资格包含未知任务门；这里只计代价边界，不保存SQL、参数或内容。
   if(sql.includes('held_unknown_task')){
    releaseQualificationQueries++;
    if(sql.includes('FROM processing_task t JOIN processing_run r'))embeddedReleaseQualificationQueries++;
   }
  };
  const measured={
   get(sql,values){observe(sql);return tx.get(sql,values);},
   all(sql,values){observe(sql);return tx.all(sql,values);},
   run:tx.run,
  };
  const began=performance.now(),summary=queueSummary(measured,String(input.ownerId),123);
  return {summary,queries,releaseQualificationQueries,embeddedReleaseQualificationQueries,elapsedMs:performance.now()-began};
 }},
]};
