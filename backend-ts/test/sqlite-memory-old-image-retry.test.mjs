import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {imageFixture} from './fixtures/memory-sqlite/image-support.mjs';
import {registry} from '../src/storage/sqlite/registry.ts';
import {releasedRunSql} from '../src/memory/sqlite/run-retirement.ts';

async function append(f,kind,localId){
 const previous=new Set((await f.history.read(f.contact)).messages.map(message=>message.id));
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[{partition:'a',table:'one',localId:String(localId),serverId:'0',sender:'contact',kind,text:kind==='text'?'合成新一轮文字':null,originalType:kind,sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['a'],exhausted:true});
 await f.history.synchronize(f.contact);const message=(await f.history.read(f.contact)).messages.find(message=>!previous.has(message.id));assert.ok(message);
 if(kind==='image'){const saved=await f.media.extract(f.contact,message.id,{requestKey:randomUUID(),goal:'extract'});return saved.files[0].fileId;}
 return message.id;
}
function measuredRead(f,db){
 const began=performance.now();let queries=0,bodyRows=0,retryQueries=0,maxRows=0;const track=(sql,rows)=>{queries++;if(sql.includes('image_retry_candidate'))retryQueries++;bodyRows+=rows.filter(row=>Object.hasOwn(row,'text_body')).length;maxRows=Math.max(maxRows,rows.length);return rows;};
 const tx={get(sql,values=[]){const stmt=db.prepare(sql);stmt.setReadBigInts(true);return track(sql,[stmt.get(...values)].filter(Boolean))[0];},all(sql,values=[]){const stmt=db.prepare(sql);stmt.setReadBigInts(true);return track(sql,stmt.all(...values));},run(){throw Error('联系人摘要必须只读');}};
 const action=registry.actions.find(action=>action.name==='memoryExtraction.readContact'),view=action.execute(tx,{ownerId:f.owner,contactId:f.contact},f.storage.status);
 return {view,queries,bodyRows,retryQueries,maxRows,elapsedMs:performance.now()-began};
}

test('两个旧隔离轮在新正常轮后逐个恢复，单轮摘要增长读取有界且不读正文',async t=>{
 const broken=new Set();let failAll=true;
 const f=await imageFixture(t,1,request=>request.images.some(image=>failAll||broken.has(image.id)));
 const first=await f.service.start(randomUUID());await f.service.waitForIdle(first.runId);failAll=false;broken.add(f.files.get(f.messages[0].id));
 const secondFile=await append(f,'image',20);broken.add(secondFile);
 const second=await f.service.start(randomUUID());await f.service.waitForIdle(second.runId);assert.equal((await f.service.read(second.runId)).isolated,1);
 await append(f,'text',30);const normal=await f.service.start(randomUUID());await f.service.waitForIdle(normal.runId);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const before=measuredRead(f,db);assert.equal(before.view.run.runId,normal.runId);assert.equal(before.view.retryRun.runId,first.runId);assert.equal(before.view.retryRun.isolated,1);assert.deepEqual(before.view.retryRun.actions,['retry_images']);
 assert.deepEqual(Object.keys(before.view.retryRun).sort(),['actions','controlVersion','isolated','runId']);assert.equal(before.bodyRows,0);assert.equal(before.retryQueries,1);
 const base=db.prepare('SELECT * FROM processing_run WHERE owner_id=? AND id=?').get(f.owner,normal.runId),contact=db.prepare('SELECT * FROM run_contact WHERE owner_id=? AND run_id=?').get(f.owner,normal.runId);
 let ten;db.exec('BEGIN');try{for(let index=0;index<100;index++){
  const run={...base,id:randomUUID(),start_request_key:randomUUID(),started_at:0,state:'completed'},scope={...contact,run_id:run.id};
  for(const [table,value]of [['processing_run',run],['run_contact',scope]]){const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>value[key]));}
  if(index===9)ten=measuredRead(f,db);
 }db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 const after=measuredRead(f,db);assert.equal(after.view.retryRun.runId,first.runId);assert.equal(after.bodyRows,0);assert.equal(after.retryQueries,1);assert.equal(after.queries,before.queries);assert.ok(after.maxRows<32);
 assert.equal(ten.queries,before.queries);assert.equal(ten.bodyRows,0);
 t.diagnostic(JSON.stringify([before,ten,after].map(({queries,bodyRows,retryQueries,maxRows,elapsedMs},index)=>({oldRuns:[0,10,100][index],queries,bodyRows,retryQueries,maxRows,elapsedMs:Math.round(elapsedMs*10)/10}))));
 const normalTask=db.prepare("SELECT id,state FROM processing_task WHERE owner_id=? AND run_id=? AND scope_kind='contact'").get(f.owner,normal.runId);
 db.prepare("UPDATE processing_run SET state='completed' WHERE owner_id=? AND id=?").run(f.owner,normal.runId);db.prepare("UPDATE processing_task SET state='unknown' WHERE owner_id=? AND id=?").run(f.owner,normalTask.id);
 assert.equal(db.prepare(`SELECT 1 FROM processing_run r WHERE r.owner_id=? AND r.id=? AND ${releasedRunSql('r')}`).get(f.owner,normal.runId),undefined,'任务级未知即使没有未知步骤或调用也不能因completed被SQL预过滤');
 db.prepare('UPDATE processing_run SET state=? WHERE owner_id=? AND id=?').run(base.state,f.owner,normal.runId);db.prepare('UPDATE processing_task SET state=? WHERE owner_id=? AND id=?').run(normalTask.state,f.owner,normalTask.id);
 await f.service.setAutomatic(false);await assert.rejects(f.service.retryImages(first.runId,after.view.retryRun.controlVersion,randomUUID()),{code:'memory_auto_processing_disabled'});await f.service.setAutomatic(true);
 const call=db.prepare('SELECT c.id,c.state,c.settlement_state,c.operation_id,o.state operation_state,a.id attempt_id FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.step_attempt_id JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=? LIMIT 1').get(f.owner,normal.runId);
 db.prepare("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND id=?").run(f.owner,call.id);db.prepare("UPDATE model_operation SET state='unknown' WHERE owner_id=? AND id=?").run(f.owner,call.operation_id);
 assert.deepEqual((await f.service.readContact(f.contact)).retryRun.actions,[]);await assert.rejects(f.service.retryImages(first.runId,after.view.retryRun.controlVersion,randomUUID()),{code:'memory_extraction_receipt_unknown'});
 db.prepare('UPDATE model_call SET state=?,settlement_state=? WHERE owner_id=? AND id=?').run(call.state,call.settlement_state,f.owner,call.id);db.prepare('UPDATE model_operation SET state=? WHERE owner_id=? AND id=?').run(call.operation_state,f.owner,call.operation_id);
 const eventId=randomUUID(),candidateId=randomUUID(),eventNo=db.prepare('SELECT coalesce(max(event_no),0)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?').get(f.owner,call.attempt_id).n;
 db.prepare("INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,'verified_output',?,?)").run(f.owner,eventId,call.attempt_id,eventNo,JSON.stringify({fact:{text:'合成待确认资料'}}),Date.now());
 db.prepare("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state,state_revision) VALUES(?,?,'contact',?,?,?,?,?,'pending',0)").run(f.owner,candidateId,f.contact,'合成待确认资料',call.attempt_id,eventId,eventNo);
 assert.deepEqual((await f.service.readContact(f.contact)).retryRun.actions,[]);await assert.rejects(f.service.retryImages(first.runId,after.view.retryRun.controlVersion,randomUUID()),{code:'memory_extraction_history_blocked'});
 db.prepare('DELETE FROM memory_candidate WHERE owner_id=? AND id=?').run(f.owner,candidateId);db.prepare('DELETE FROM execution_event WHERE owner_id=? AND id=?').run(f.owner,eventId);
 const feedback=db.prepare('SELECT feedback_revision FROM contact WHERE owner_id=? AND id=?').get(f.owner,f.contact).feedback_revision;db.prepare('UPDATE contact SET feedback_revision=feedback_revision+1 WHERE owner_id=? AND id=?').run(f.owner,f.contact);
 assert.equal((await f.service.readContact(f.contact)).retryRun,undefined);await assert.rejects(f.service.retryImages(first.runId,after.view.retryRun.controlVersion,randomUUID()),{code:'memory_extraction_no_isolated_images'});db.prepare('UPDATE contact SET feedback_revision=? WHERE owner_id=? AND id=?').run(feedback,f.owner,f.contact);
 broken.delete(f.files.get(f.messages[0].id));await f.service.retryImages(first.runId,after.view.retryRun.controlVersion,randomUUID());await f.service.waitForIdle(first.runId);
 const next=await f.service.readContact(f.contact);assert.equal(next.run.runId,normal.runId);assert.equal(next.retryRun.runId,second.runId);
 broken.delete(secondFile);await f.service.retryImages(second.runId,next.retryRun.controlVersion,randomUUID());await f.service.waitForIdle(second.runId);
 assert.equal((await f.service.readContact(f.contact)).retryRun,undefined);assert.equal((await f.service.read(first.runId)).isolated??0,0);assert.equal((await f.service.read(second.runId)).isolated??0,0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
