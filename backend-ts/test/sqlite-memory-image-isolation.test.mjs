import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {fixture as memoryFixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMediaService} from '../src/media/sqlite/service.ts';
import {createExtractionPolicyVersion} from '../src/memory/extraction/policy-version.ts';
import {isolatedInputs,recordImageIsolation,retryIsolatedImages,canRetryIsolatedImages} from '../src/memory/sqlite/image-isolation.ts';

const png=await sharp({create:{width:4,height:3,channels:3,background:'orange'}}).png().toBuffer();
const sha256=createHash('sha256').update(png).digest('hex');
const adapter={version:'synthetic-image-isolation-v1',supports:kind=>kind==='image',async execute(context){
 await context.save({role:'image_display',bytes:(async function*(){yield png;})(),expectedBytes:png.length,expectedSha256:sha256,
  validate:async()=>({format:'png',mimeType:'image/png',containerValid:true,viewable:true,playable:false})});
 return {association:{protocol:'media-association-v1',profileId:'synthetic-image-isolation-v1',recordId:context.source.recordId,messageId:context.messageId,resourceIdentity:'synthetic-image'}};
}};
async function fixture(t,imageCount=1){
 const base=await memoryFixture(t),contact=base.saved[0].contact_id;
 base.channel.page=async()=>({target:base.target.descriptor,cursorIn:null,cursorOut:null,records:[
  ...Array.from({length:imageCount},(_,index)=>record(String(index+1),{kind:'image',text:null,originalType:'image'})),record('100')
 ],completedPartitions:base.target.partitions,exhausted:true});
 await base.service.synchronize(contact);
 const media=new SqliteMediaService({storage:base.storage,contacts:base.contacts,history:base.service,userData:base.root,adapters:[adapter]});await media.initialize();t.after(()=>media.close());
 const f={...base,owner,contact,history:base.service,media};
 const images=(await f.history.read(f.contact)).messages.filter(message=>message.kind==='image');
 for(const image of images)await f.media.extract(f.contact,image.id,{requestKey:`isolation-${image.id}`,goal:'extract'});
 const policy=await createExtractionPolicyVersion(),run=await f.storage.execute('memoryExtraction.start',{ownerId:f.owner,requestKey:randomUUID(),policyConfig:policy.newTaskConfig()});
 const task=run.tasks.find(task=>task.contactId===f.contact),batch=await f.storage.execute('memoryExtraction.claim',{ownerId:f.owner,runId:run.runId,taskId:task.taskId});
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());
 const statement=(sql,values=[])=>{const s=db.prepare(sql);s.setReadBigInts(true);return [s,values];};
 const tx={get(sql,values){const [s,v]=statement(sql,values);return s.get(...v);},all(sql,values){const [s,v]=statement(sql,values);return s.all(...v);},run(sql,values=[]){db.prepare(sql).run(...values);}};
 const transact=work=>{db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}};
 const imageRows=batch.rows.filter(row=>row.content_kind==='image');
 const isolate=row=>transact(()=>recordImageIsolation(tx,{ownerId:f.owner,attemptId:batch.attemptId,inputNo:Number(row.input_no)},f.storage.status));
 const finish=(state='failed')=>transact(()=>{
  tx.run('UPDATE step_attempt SET state=?,finished_at=? WHERE owner_id=? AND id=?',[state,Date.now(),f.owner,batch.attemptId]);
  tx.run('UPDATE processing_step SET state=?,successful_attempt_id=? WHERE owner_id=? AND id=?',[state,state==='succeeded'?batch.attemptId:null,f.owner,batch.stepId]);
  tx.run("UPDATE processing_task SET state=? WHERE owner_id=? AND id=?",[state,f.owner,task.taskId]);
  tx.run("UPDATE processing_run SET state='incomplete' WHERE owner_id=? AND id=?",[f.owner,run.runId]);
 });
 return {...f,db,tx,transact,run,batch,imageRows,isolate,finish};
}

test('单张隔离保存原图依据与删除依赖，重复登记不增加失败次数且不越过owner和输入范围',async t=>{
 const f=await fixture(t),row=f.imageRows[0],result=f.isolate(row);
 assert.deepEqual(result,{paused:false,count:1});
 const isolated=isolatedInputs(f.tx,f.owner,f.run.runId);assert.equal(isolated.length,1);
 assert.equal(isolated[0].inputNo,Number(row.input_no));assert.equal(isolated[0].itemId,row.item_id);assert.equal(isolated[0].sha256,sha256);
 assert.equal(f.tx.get('SELECT count(*) AS n FROM execution_input WHERE owner_id=? AND event_id=?',[f.owner,isolated[0].eventId]).n,1n);
 assert.equal(f.tx.get('SELECT count(*) AS n FROM event_source WHERE owner_id=? AND event_id=?',[f.owner,isolated[0].eventId]).n,1n);
 const payload=JSON.parse(f.tx.get('SELECT payload FROM execution_event WHERE owner_id=? AND id=?',[f.owner,isolated[0].eventId]).payload);
 assert.equal(payload.reason,'media_model_input_unavailable');assert.equal(payload.file_id,isolated[0].fileId);assert.equal(payload.sha256,sha256);assert.equal(Object.hasOwn(payload,'text'),false);
 assert.deepEqual(f.isolate(row),result);assert.equal(isolatedInputs(f.tx,f.owner,f.run.runId).length,1);
 assert.deepEqual(isolatedInputs(f.tx,'other-owner',f.run.runId),[]);
 assert.throws(()=>f.transact(()=>recordImageIsolation(f.tx,{ownerId:'other-owner',attemptId:f.batch.attemptId,inputNo:Number(row.input_no)},f.storage.status)),{code:'memory_extraction_attempt_stale'});
 const text=f.batch.rows.find(row=>row.content_kind==='text');assert.throws(()=>f.isolate(text),{code:'memory_extraction_input_not_frozen'});
});

test('显式图片重试以CAS及操作标识幂等建新步骤，原成功步骤和来源依据保留',async t=>{
 const f=await fixture(t);f.isolate(f.imageRows[0]);f.finish('succeeded');
 assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),true);
 const input={ownerId:f.owner,runId:f.run.runId,actionVersion:0,operationId:randomUUID()};
 assert.deepEqual(f.transact(()=>retryIsolatedImages(f.tx,input)),{ownerId:f.owner,runId:f.run.runId,replayed:false});
 assert.deepEqual(f.transact(()=>retryIsolatedImages(f.tx,input)),{ownerId:f.owner,runId:f.run.runId,replayed:true});
 const steps=f.tx.all('SELECT * FROM processing_step WHERE owner_id=? AND task_id=? ORDER BY step_no',[f.owner,f.batch.taskId]);
 assert.equal(steps.length,2);assert.equal(steps[0].state,'succeeded');assert.equal(steps[0].successful_attempt_id,f.batch.attemptId);assert.equal(steps[1].state,'pending');
 assert.equal(f.tx.get('SELECT extraction_state FROM processing_item WHERE owner_id=? AND id=?',[f.owner,f.imageRows[0].item_id]).extraction_state,'pending');
 assert.equal(isolatedInputs(f.tx,f.owner,f.run.runId).length,0);
 const events=f.tx.all("SELECT * FROM execution_event WHERE owner_id=? AND kind='image_retry_requested'",[f.owner]);assert.equal(events.length,1);
 assert.equal(f.tx.get('SELECT count(*) AS n FROM execution_input WHERE owner_id=? AND event_id=?',[f.owner,events[0].id]).n,1n);
 assert.equal(f.tx.get('SELECT count(*) AS n FROM event_source WHERE owner_id=? AND event_id=?',[f.owner,events[0].id]).n,1n);
 assert.equal(JSON.parse(events[0].payload).sha256,sha256);
 assert.throws(()=>f.transact(()=>retryIsolatedImages(f.tx,{...input,actionVersion:1})),{code:'memory_extraction_control_conflict'});
 assert.throws(()=>f.transact(()=>retryIsolatedImages(f.tx,{...input,operationId:randomUUID()})),{code:'memory_extraction_control_conflict'});
});

test('连续三张同类隔离持久暂停，显式重试后新隔离重新计数',async t=>{
 const f=await fixture(t,3);
 assert.deepEqual(f.isolate(f.imageRows[0]),{paused:false,count:1});assert.deepEqual(f.isolate(f.imageRows[1]),{paused:false,count:2});
 assert.deepEqual(f.isolate(f.imageRows[2]),{paused:true,count:3});
 const paused=f.tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[f.owner,f.run.runId]);assert.equal(paused.state,'paused');assert.notEqual(paused.pause_requested_at,null);assert.equal(paused.intent_revision,1n);
 f.finish();f.transact(()=>retryIsolatedImages(f.tx,{ownerId:f.owner,runId:f.run.runId,actionVersion:1,operationId:randomUUID()}));
 const batch=await f.storage.execute('memoryExtraction.claim',{ownerId:f.owner,runId:f.run.runId,taskId:f.batch.taskId}),row=batch.rows.find(row=>row.content_kind==='image');
 assert.deepEqual(f.transact(()=>recordImageIsolation(f.tx,{ownerId:f.owner,attemptId:batch.attemptId,inputNo:Number(row.input_no)},f.storage.status)),{paused:false,count:1});
});

test('成功子窗事件打断连续失败计数',async t=>{
 const f=await fixture(t,3);f.isolate(f.imageRows[0]);f.isolate(f.imageRows[1]);
 await f.storage.execute('memoryExtraction.event',{ownerId:f.owner,attemptId:f.batch.attemptId,kind:'image_input_recovered',payload:{slot:1},inputNos:[Number(f.imageRows[0].input_no)]});
 assert.deepEqual(f.isolate(f.imageRows[2]),{paused:false,count:1});
});

test('图片删除清掉隔离及重试事件与来源依赖，不能据旧原因恢复读取',async t=>{
 const f=await fixture(t);f.isolate(f.imageRows[0]);f.finish();f.transact(()=>retryIsolatedImages(f.tx,{ownerId:f.owner,runId:f.run.runId,actionVersion:0,operationId:randomUUID()}));
 const ids=f.tx.all("SELECT id FROM execution_event WHERE owner_id=? AND kind IN ('media_input_isolated','image_retry_requested')",[f.owner]).map(row=>row.id);assert.equal(ids.length,2);
 await f.media.clear(f.contact,f.imageRows[0].message_id,randomUUID());
 for(const table of ['execution_event','execution_input','event_source'])assert.equal(f.tx.get(`SELECT count(*) AS n FROM ${table} WHERE owner_id=? AND ${table==='execution_event'?'id':'event_id'} IN (SELECT value FROM json_each(?))`,[f.owner,JSON.stringify(ids)]).n,0n);
 assert.deepEqual(isolatedInputs(f.tx,f.owner,f.run.runId),[]);assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),false);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('隔离图片恢复动作由后端发布，关闭开关禁止执行，未知回执和活动租约不提供入口',async t=>{
 const {projectControl}=await import('../src/memory/sqlite/control.ts');
 const f=await fixture(t);f.isolate(f.imageRows[0]);
 const projection=()=>projectControl(f.tx,f.owner,f.tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[f.owner,f.run.runId]),{laterStages:'completed'});
 assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),false,'当前租约未结束不能重试');assert.equal(projection().actions.includes('retry_images'),false);
 f.finish();assert.equal(projection().actions.includes('retry_images'),true);
 f.transact(()=>f.tx.run('UPDATE database_instance SET memory_auto_processing=0 WHERE slot=1'));
 assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),true);assert.equal(projection().actions.includes('retry_images'),true);
 assert.throws(()=>f.transact(()=>retryIsolatedImages(f.tx,{ownerId:f.owner,runId:f.run.runId,actionVersion:0,operationId:randomUUID()})),{code:'memory_auto_processing_disabled'});
 f.transact(()=>{f.tx.run('UPDATE database_instance SET memory_auto_processing=1 WHERE slot=1');f.tx.run("UPDATE step_attempt SET state='unknown' WHERE owner_id=? AND id=?",[f.owner,f.batch.attemptId]);});
 assert.equal(projection().actions.includes('retry_images'),false);
 assert.throws(()=>f.transact(()=>retryIsolatedImages(f.tx,{ownerId:f.owner,runId:f.run.runId,actionVersion:0,operationId:randomUUID()})),{code:'memory_extraction_receipt_unknown'});
});

test('待确认候选保持原门槛，不能借图片重试重置待决定结果',async t=>{
 const f=await fixture(t);f.isolate(f.imageRows[0]);f.finish('succeeded');
 f.transact(()=>{
  const eventId=randomUUID(),eventNo=f.tx.get('SELECT max(event_no)+1 AS n FROM execution_event WHERE owner_id=? AND step_attempt_id=?',[f.owner,f.batch.attemptId]).n;
  f.tx.run("INSERT INTO execution_event(owner_id,id,step_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,'verified_output',?,?)",[f.owner,eventId,f.batch.attemptId,eventNo,JSON.stringify({fact:{text:'合成待确认资料'}}),Date.now()]);
  f.tx.run("INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state,state_revision) VALUES(?,?,'contact',?,?,?,?,?,'pending',0)",[f.owner,randomUUID(),f.contact,'合成待确认资料',f.batch.attemptId,eventId,eventNo]);
 });
 assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),false);
 assert.throws(()=>f.transact(()=>retryIsolatedImages(f.tx,{ownerId:f.owner,runId:f.run.runId,actionVersion:0,operationId:randomUUID()})),{code:'memory_extraction_history_blocked'});
 assert.equal(f.tx.get("SELECT count(*) AS n FROM execution_event WHERE owner_id=? AND kind='image_retry_requested'",[f.owner]).n,0n);
});

test('已准备模型调用阻断重试，账本结算未知不能借失败状态释放',async t=>{
 const f=await fixture(t);f.isolate(f.imageRows[0]);
 const call=await f.storage.execute('memoryExtraction.prepareCall',{ownerId:f.owner,attemptId:f.batch.attemptId,purpose:'extraction',request:{synthetic:true},provider:'synthetic',model:'synthetic',configurationId:'synthetic-v1',inputCap:1000,outputCap:10,inputNos:[Number(f.imageRows[0].input_no)]});
 f.finish();assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),false);
 f.transact(()=>{
  f.tx.run("UPDATE model_call SET state='failed',settlement_state='unknown' WHERE owner_id=? AND id=?",[f.owner,call.callId]);
  f.tx.run("UPDATE model_operation SET state='failed' WHERE owner_id=? AND id=(SELECT operation_id FROM model_call WHERE owner_id=? AND id=?)",[f.owner,f.owner,call.callId]);
  f.tx.run("UPDATE operation_item SET state='released' WHERE owner_id=?",[f.owner]);f.tx.run("UPDATE operation_scope SET state='released' WHERE owner_id=?",[f.owner]);
 });
 assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),false);
 assert.throws(()=>f.transact(()=>retryIsolatedImages(f.tx,{ownerId:f.owner,runId:f.run.runId,actionVersion:0,operationId:randomUUID()})),{code:'memory_extraction_receipt_unknown'});
});

test('取消联系人后，旧重试操作的幂等回执也必须重新核对来源',async t=>{
 const f=await fixture(t);f.isolate(f.imageRows[0]);f.finish();
 const input={ownerId:f.owner,runId:f.run.runId,actionVersion:0,operationId:randomUUID()};f.transact(()=>retryIsolatedImages(f.tx,input));
 const binding=f.saved.find(binding=>binding.contact_id===f.contact);await f.contacts.revoke(f.contact,binding.binding_id,binding.selection_generation);
 assert.throws(()=>f.transact(()=>retryIsolatedImages(f.tx,input)),{code:'memory_extraction_scope_stale'});
 assert.equal(canRetryIsolatedImages(f.tx,f.owner,f.run.runId),false);
});

test('同一步骤跨attempt重复隔离只计一次，显式重试的新步骤才登记新的失败',async t=>{
 const f=await fixture(t),row=f.imageRows[0];assert.deepEqual(f.isolate(row),{paused:false,count:1});f.finish();
 await f.storage.execute('memoryExtraction.control',{ownerId:f.owner,runId:f.run.runId,action:'continue',actionVersion:0,operationId:randomUUID()});
 const resumed=await f.storage.execute('memoryExtraction.claim',{ownerId:f.owner,runId:f.run.runId,taskId:f.batch.taskId});
 assert.equal(resumed.stepId,f.batch.stepId);assert.notEqual(resumed.attemptId,f.batch.attemptId);
 assert.deepEqual(f.transact(()=>recordImageIsolation(f.tx,{ownerId:f.owner,attemptId:resumed.attemptId,inputNo:Number(row.input_no)},f.storage.status)),{paused:false,count:1});
 assert.equal(f.tx.get("SELECT count(*) AS n FROM execution_event WHERE owner_id=? AND kind='media_input_isolated'",[f.owner]).n,1n);
 f.transact(()=>{
  f.tx.run("UPDATE step_attempt SET state='failed',finished_at=? WHERE owner_id=? AND id=?",[Date.now(),f.owner,resumed.attemptId]);
  f.tx.run("UPDATE processing_step SET state='failed' WHERE owner_id=? AND id=?",[f.owner,resumed.stepId]);
  f.tx.run("UPDATE processing_task SET state='failed' WHERE owner_id=? AND id=?",[f.owner,f.batch.taskId]);
  f.tx.run("UPDATE processing_run SET state='incomplete' WHERE owner_id=? AND id=?",[f.owner,f.run.runId]);
 });
 f.transact(()=>retryIsolatedImages(f.tx,{ownerId:f.owner,runId:f.run.runId,actionVersion:1,operationId:randomUUID()}));
 const retried=await f.storage.execute('memoryExtraction.claim',{ownerId:f.owner,runId:f.run.runId,taskId:f.batch.taskId});
 assert.notEqual(retried.stepId,f.batch.stepId);
 assert.deepEqual(f.transact(()=>recordImageIsolation(f.tx,{ownerId:f.owner,attemptId:retried.attemptId,inputNo:Number(row.input_no)},f.storage.status)),{paused:false,count:1});
 assert.equal(f.tx.get("SELECT count(*) AS n FROM execution_event WHERE owner_id=? AND kind='media_input_isolated'",[f.owner]).n,2n);
});
