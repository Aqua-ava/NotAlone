import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';

function addHistory(f,taskId,state,{latest=false}={}){
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));
 try{
  const task=db.prepare('SELECT * FROM processing_task WHERE owner_id=? AND id=?').get(f.owner,taskId),id=randomUUID(),attemptId=randomUUID();
  const n=db.prepare(`SELECT ${latest?'max':'min'}(step_no) AS n FROM processing_step WHERE owner_id=? AND task_id=?`).get(f.owner,taskId).n+(latest?1:-1);
  db.prepare("INSERT INTO processing_step(owner_id,id,task_id,step_no,kind,state,input_state,accepted_memory_revision) VALUES(?,?,?,?,'document_scene',?,'frozen',?)").run(f.owner,id,taskId,n,state,task.accepted_memory_revision);
  db.prepare('INSERT INTO step_attempt(owner_id,id,step_id,attempt_no,resume_no,lease_token,lease_expires_at,accepted_control_revision,runtime_token,state,started_at,finished_at,error_code) VALUES(?,?,?,1,?, ?,0,?,?,?,0,1,?)').run(f.owner,attemptId,id,task.resume_no,randomUUID(),task.control_revision,'synthetic-history',state,'synthetic_scene_rejected');
  return {id,attemptId};
 }finally{db.close();}
}

for(const historicalState of ['failed','unknown'])test(`文档重试保留旧${historicalState}历史，并按当前阶段及未解调用判定发布`,async t=>{
 const f=await deletionFixture(t,{laterScheduling:true,laterSchedulingContactOnly:true});
 const execute=f.storage.execute.bind(f.storage);let history,taskId;
 f.storage.execute=async(name,input)=>{
  if(name==='memoryDocuments.publish'&&!history){
   const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
   const task=db.prepare('SELECT contact_id FROM processing_task WHERE owner_id=? AND id=?').get(f.owner,input.taskId);db.close();
   if(task.contact_id===f.contactId){taskId=input.taskId;history=addHistory(f,taskId,historicalState);}
  }
  return execute(name,input);
 };
 const run=await f.extraction.start(`synthetic-document-history-${historicalState}`);await f.extraction.waitForIdle(run.runId);
 await f.documents.publishRun(run.runId,f.contactId);
 assert.ok(history,'必须在实际发布前加入独立历史步骤');
 let state=await f.documents.readTask(taskId),view=await f.documents.read({scopeKind:'contact',contactId:f.contactId});
 assert.deepEqual(state.stages.map(stage=>stage.status),['succeeded','succeeded'],'展示每种阶段的最新结果，保留旧失败供审计');
 if(historicalState==='unknown'){
  assert.equal(state.outcome,'incomplete');assert.equal(view.publication,null,'较早未知仍必须阻止发布');
 }else{
  assert.equal(state.outcome,'completed');assert.ok(view.publication);
  assert.equal((await f.documents.queueSummary()).pending,0,'完整发布须结清同联系人的后置队列');
  const newer=addHistory(f,taskId,'failed',{latest:true});
  state=await f.documents.readTask(taskId);
  assert.equal(state.outcome,'incomplete');assert.equal(state.stages.find(stage=>stage.kind==='scene').status,'failed','较早成功不能遮住最新失败');
  const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));
  db.prepare("UPDATE processing_step SET state='unknown' WHERE owner_id=? AND id=?").run(f.owner,newer.id);
  db.prepare("UPDATE step_attempt SET state='unknown' WHERE owner_id=? AND id=?").run(f.owner,newer.attemptId);db.close();
  state=await f.documents.readTask(taskId);assert.equal(state.outcome,'incomplete');assert.equal(state.stages.find(stage=>stage.kind==='scene').status,'unknown');
 }
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 assert.equal(db.prepare('SELECT state FROM processing_step WHERE owner_id=? AND id=?').get(f.owner,history.id).state,historicalState);
 assert.equal(db.prepare('SELECT state FROM step_attempt WHERE owner_id=? AND id=?').get(f.owner,history.attemptId).state,historicalState);db.close();
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
